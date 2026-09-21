import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createGateway } from './gateway.mjs';

test('gateway preserves same-origin routes and cookies, blocks private policy and handles unavailable upstream', async () => {
  const servers = [];
  const listen = async (server) => {
    servers.push(server);
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${server.address().port}`;
  };
  try {
    const targets = {};
    for (const name of ['bff', 'organizer', 'storefront'])
      targets[name] = await listen(
        createServer((request, response) => {
          response.setHeader('set-cookie', 'session=opaque; HttpOnly; SameSite=Lax; Path=/');
          response.end(JSON.stringify({ name, url: request.url, origin: request.headers.origin }));
        }),
      );
    const origin = await listen(createGateway(targets));
    for (const [path, name] of [
      ['/api/v1/auth/session', 'bff'],
      ['/organizer/?org=example', 'organizer'],
      ['/', 'storefront'],
    ]) {
      const response = await fetch(origin + path, { headers: { origin } });
      assert.deepEqual(await response.json(), { name, url: path, origin });
      assert.match(response.headers.get('set-cookie'), /HttpOnly/);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    }
    assert.equal((await fetch(origin + '/internal/policy/check')).status, 404);
    assert.equal((await fetch(origin + '/organizer', { redirect: 'manual' })).status, 308);
    await new Promise((done) => {
      servers[0].closeAllConnections();
      servers[0].close(done);
    });
    assert.equal((await fetch(origin + '/api/v1/auth/session')).status, 503);
    assert.equal((await fetch(origin + '/health/ready')).status, 200);
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      ),
    );
  }
});
