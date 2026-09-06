import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OrdersController } from '../dist/orders.controller.js';
import { PublicController } from '../dist/public.controller.js';

async function server(handle) {
  const app = createServer((request, response) => {
    request.resume();
    handle(request, response);
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${app.address().port}`,
    async close() {
      app.closeAllConnections();
      await new Promise((resolve) => app.close(resolve));
    },
  };
}
function auth(origin) {
  return {
    config: { BOOKING_URL: origin, CATALOG_URL: origin },
    store: { rateLimit: async () => {} },
    assertCsrf: () => {},
    requireSession: async () => ({
      session: {
        user: { sub: 'buyer' },
        csrf: 'csrf-fixture',
        accessToken: 'synthetic-access-token',
      },
    }),
  };
}
function response() {
  return {
    locals: {
      requestId: randomUUID(),
      traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    },
    setHeader() {},
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
    },
  };
}
const request = (method, path, originalUrl = path, body) => ({
  method,
  path,
  originalUrl,
  body,
  header: () => randomUUID(),
});

test('absolute-form URLs cannot redirect either proxy or receive the server bearer token', async () => {
  const received = [];
  let leaked = 0;
  const trusted = await server((req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
  const untrusted = await server((_req, res) => {
    leaked++;
    res.end('{}');
  });
  try {
    await new OrdersController(auth(trusted.origin)).forward(
      request('GET', '/api/v1/orders', untrusted.origin + '/api/v1/orders?page=2'),
      response(),
    );
    await new PublicController(auth(trusted.origin)).events(
      request('GET', '/api/v1/events', untrusted.origin + '/api/v1/events?page=3'),
      response(),
    );
    assert.equal(leaked, 0);
    assert.deepEqual(received, [
      { path: '/api/v1/orders?page=2', authorization: 'Bearer synthetic-access-token' },
      { path: '/api/v1/events?page=3', authorization: undefined },
    ]);
  } finally {
    await trusted.close();
    await untrusted.close();
  }
});

test('a malformed success body after commit becomes retryable 503', async () => {
  const upstream = await server((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.statusCode = req.url.startsWith('/api/v1/events/') ? 200 : 201;
    res.end(req.url.startsWith('/api/v1/events/') ? '{}' : '{');
  });
  try {
    await assert.rejects(
      new OrdersController(auth(upstream.origin)).forward(
        request('POST', '/api/v1/orders', undefined, { saleId: randomUUID(), seatIds: ['r1-s1'] }),
        response(),
      ),
      (error) => error.getStatus() === 503 && error.getResponse().code === 'BOOKING_UNAVAILABLE',
    );
  } finally {
    await upstream.close();
  }
});

test('unpublished events cannot create an order, while existing order reads do not depend on Catalog', async () => {
  let orders = 0;
  const upstream = await server((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/v1/events/')) {
      res.statusCode = 404;
    } else orders++;
    res.end('{}');
  });
  try {
    const controller = new OrdersController(auth(upstream.origin));
    await assert.rejects(
      controller.forward(
        request('POST', '/api/v1/orders', undefined, { saleId: randomUUID(), seatIds: ['r1-s1'] }),
        response(),
      ),
      (error) => error.getStatus() === 404,
    );
    assert.equal(orders, 0);
    await controller.forward(request('GET', `/api/v1/orders/${randomUUID()}`), response());
    assert.equal(orders, 1);
    await assert.rejects(
      controller.forward(request('POST', `/api/v1/orders/${randomUUID()}/confirm`), response()),
      (error) => error.getStatus() === 404,
    );
    assert.equal(orders, 1);
  } finally {
    await upstream.close();
  }
});
