import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import { eventually } from './eventually.mjs';

export async function findMail(messageId) {
  const url = new URL('/api/v1/search', process.env.MAILPIT_URL);
  url.searchParams.set('query', `message-id:${messageId}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return (await response.json()).messages ?? [];
}

export async function receivedMail(messageId) {
  const messages = await eventually(
    () => findMail(messageId),
    (items) => items.length > 0,
  );
  assert.equal(messages.length, 1);
  const response = await fetch(
    new URL(`/api/v1/message/${messages[0].ID}`, process.env.MAILPIT_URL),
  );
  assert.equal(response.status, 200);
  return response.json();
}

export async function smtpProxy() {
  let online = false;
  const connections = new Set();
  const server = createServer((client) => {
    if (!online) return client.destroy();
    const upstream = createConnection(Number(process.env.MAILPIT_SMTP_PORT), '127.0.0.1');
    connections.add(client);
    client.on('close', () => {
      connections.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    restore: () => {
      online = true;
    },
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
