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

test('real gateway rate limits return retry metadata while health stays reachable', async () => {
  const upstream = createServer((_request, response) => response.end('{}'));
  let gateway;
  try {
    await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
    const target = `http://127.0.0.1:${upstream.address().port}`;
    gateway = createGateway({ bff: target, limits: { apiRequests: 1 } });
    await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${gateway.address().port}`;
    assert.equal((await fetch(origin + '/api/v1/events')).status, 200);
    const limited = await fetch(origin + '/api/v1/events', {
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(limited.headers.get('cache-control'), 'no-store');
    const body = await limited.json();
    assert.equal(body.code, 'RATE_LIMITED');
    assert.equal(body.retryable, true);
    assert.equal((await fetch(origin + '/health/ready')).status, 200);
  } finally {
    for (const server of [gateway, upstream])
      if (server) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
  }
});

test('gateway lets bounded slow API operations finish and still times out regular requests', async () => {
  const upstream = createServer((_request, response) => {
    const timer = setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    }, 200);
    response.once('close', () => clearTimeout(timer));
  });
  let gateway;
  try {
    await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
    gateway = createGateway({
      bff: `http://127.0.0.1:${upstream.address().port}`,
      proxyTimeouts: { standardMs: 50, extendedApiMs: 3000 },
    });
    await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${gateway.address().port}`;
    const id = '9caab5f0-598d-4c5c-a39a-d3d518c1d84c';
    const event = `/api/v1/organizations/${id}/events/${id}`;
    const calls = [
      ['GET', `${event}/cover`, 200],
      ['POST', '/api/v1/offline-check-in/sync', 200],
      ['POST', '/api/v1/orders', 200],
      ['GET', `/api/v1/organizations/${id}/analytics`, 200],
      ['GET', `${event}/waitlist`, 200],
      ['GET', '/api/v1/events', 503],
      ['GET', '/api/v1/orders', 503],
      ['GET', '/api/v1/offline-check-in/unknown', 503],
    ];
    await Promise.all(
      calls.map(async ([method, path, status]) => {
        const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, status, `${method} ${path}`);
        if (status === 503) assert.equal((await response.json()).code, 'UNAVAILABLE');
        else assert.deepEqual(await response.json(), {});
      }),
    );
  } finally {
    for (const server of [gateway, upstream]) {
      if (!server?.listening) continue;
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }
});
