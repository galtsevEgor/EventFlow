import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ApiError } from '@eventflow/service-runtime';
import { OrdersController } from '../dist/orders.controller.js';
import { PublicController } from '../dist/public.controller.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { CatalogController } from '../dist/catalog.controller.js';

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
const analyticsDisabled = { enabled: false, session: { read: () => null } };
function auth(origin) {
  return {
    config: { BOOKING_URL: origin, CATALOG_URL: origin, PAYMENTS_URL: origin },
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

test('Catalog and Orders check the route, session and CSRF in order and use separate rate buckets', async () => {
  let forwarded = 0;
  const upstream = await server((_req, res) => {
    forwarded++;
    res.end('{}');
  });
  try {
    const authorization = auth(upstream.origin);
    const activeSession = authorization.requireSession;
    const calls = [];
    let signedIn = false;
    authorization.config.PUBLIC_ORIGIN = 'https://eventflow.test';
    authorization.requireSession = async () => {
      calls.push('session');
      if (!signedIn) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in');
      return activeSession();
    };
    authorization.assertCsrf = (req, token) => {
      calls.push('csrf');
      AuthService.prototype.assertCsrf.call(authorization, req, token);
    };
    authorization.store.rateLimit = async (key, limit) => {
      calls.push([key, limit]);
      if (key === 'orders:buyer') throw new ApiError(429, 'RATE_LIMITED', 'Slow down');
    };
    const catalog = new CatalogController(authorization);
    const orders = new OrdersController(authorization, analyticsDisabled);
    const path = `/api/v1/orders/${randomUUID()}`;
    const hasStatus = (status) => (error) => error.getStatus() === status;

    await assert.rejects(orders.forward(request('PUT', path), response()), hasStatus(404));
    await assert.rejects(
      catalog.forward(request('PUT', '/api/v1/organizations'), response()),
      hasStatus(404),
    );
    assert.deepEqual(calls, []);
    await assert.rejects(
      orders.forward(request('POST', `${path}/cancel`), response()),
      hasStatus(401),
    );
    assert.deepEqual(calls.splice(0), ['session']);
    signedIn = true;
    const mutation = request('POST', `${path}/cancel`);
    mutation.header = () => undefined;
    await assert.rejects(orders.forward(mutation, response()), hasStatus(403));
    assert.deepEqual(calls.splice(0), ['session', 'csrf']);
    mutation.header = (name) =>
      ({ origin: authorization.config.PUBLIC_ORIGIN, 'x-csrf-token': 'csrf-fixture' })[name];
    await assert.rejects(orders.forward(mutation, response()), hasStatus(429));
    assert.deepEqual(calls.splice(0), ['session', 'csrf', ['orders:buyer', 120]]);
    assert.equal(forwarded, 0);
    await catalog.forward(request('GET', '/api/v1/organizations'), response());
    assert.deepEqual(calls, ['session', ['api:buyer', 120]]);
    assert.equal(forwarded, 1);
  } finally {
    await upstream.close();
  }
});
test('only reservation creation forwards the signed analytics session and caller headers cannot override it', async () => {
  const received = [];
  const upstream = await server((req, res) => {
    received.push({ path: req.url, session: req.headers['x-analytics-session'] });
    res.setHeader('content-type', 'application/json');
    res.statusCode = req.method === 'POST' ? 201 : 200;
    res.end('{}');
  });
  try {
    const signed = randomUUID(),
      untrusted = randomUUID();
    let reads = 0;
    const controller = new OrdersController(auth(upstream.origin), {
      enabled: true,
      session: {
        read: () => {
          reads++;
          return { id: signed };
        },
      },
    });
    const input = request('POST', '/api/v1/orders', '/api/v1/orders', {
      saleId: randomUUID(),
      seatIds: ['r1-s1'],
    });
    input.header = (name) => (name === 'x-analytics-session' ? untrusted : randomUUID());
    await controller.forward(input, response());
    await controller.forward(request('GET', '/api/v1/orders'), response());
    assert.equal(reads, 1);
    assert.equal(received.find((r) => r.path === '/api/v1/orders' && r.session).session, signed);
    assert.equal(received.filter((r) => r.session).length, 1);
  } finally {
    await upstream.close();
  }
});

test('organizer refunds route to Booking and reject invalid CSRF before forwarding', async () => {
  const received = [];
  const upstream = await server((req, res) => {
    received.push({ path: req.url, key: req.headers['idempotency-key'] });
    res.setHeader('content-type', 'application/json');
    res.statusCode = 202;
    res.end('{}');
  });
  try {
    const authorization = auth('http://127.0.0.1:1');
    authorization.config.BOOKING_URL = upstream.origin;
    authorization.config.PUBLIC_ORIGIN = 'https://eventflow.test';
    authorization.assertCsrf = AuthService.prototype.assertCsrf;
    const controller = new CatalogController(authorization);
    const path = `/api/v1/organizations/${randomUUID()}/events/${randomUUID()}/orders/${randomUUID()}/refund`;
    const key = randomUUID();
    const req = request('POST', path, path, { reason: 'Event cancelled' });
    for (const [origin, csrf] of [
      ['https://attacker.test', 'csrf-fixture'],
      ['https://eventflow.test', 'wrong'],
    ]) {
      req.header = (name) => (name === 'origin' ? origin : csrf);
      await assert.rejects(
        controller.forward(req, response()),
        (error) => error.getStatus() === 403,
      );
    }
    assert.equal(received.length, 0);
    req.header = (name) =>
      ({
        origin: 'https://eventflow.test',
        'x-csrf-token': 'csrf-fixture',
        'idempotency-key': key,
      })[name];
    const res = response();
    await controller.forward(req, res);
    assert.equal(res.statusCode, 202);
    assert.deepEqual(received, [{ path, key }]);
  } finally {
    await upstream.close();
  }
});

test('payment routes preserve the original key and cannot forward tokens to an arbitrary origin', async () => {
  const received = [];
  const upstream = await server((req, res) => {
    received.push({
      path: req.url,
      key: req.headers['idempotency-key'],
      auth: req.headers.authorization,
    });
    res.setHeader('content-type', 'application/json');
    res.statusCode = req.method === 'POST' ? 202 : 200;
    res.end('{}');
  });
  let unexpected = 0;
  const other = await server((_req, res) => {
    unexpected++;
    res.end('{}');
  });
  try {
    const authorization = auth(other.origin);
    authorization.config.PAYMENTS_URL = upstream.origin;
    const controller = new OrdersController(authorization, analyticsDisabled);
    const id = randomUUID(),
      key = randomUUID();
    for (const [method, suffix] of [
      ['GET', 'payment-status'],
      ['POST', 'payment-attempt'],
      ['POST', 'payment-attempt/fake-confirm'],
    ]) {
      const path = `/api/v1/orders/${id}/${suffix}`;
      const req = request(method, path, other.origin + path, {});
      req.header = () => key;
      const res = response();
      await controller.forward(req, res);
      assert.equal(res.statusCode, method === 'POST' ? 202 : 200);
    }
    assert.equal(unexpected, 0);
    assert.equal(received.length, 3);
    assert.ok(
      received.every((item) => item.key === key && item.auth === 'Bearer synthetic-access-token'),
    );
    for (const [method, suffix] of [
      ['DELETE', 'payment-attempt'],
      ['POST', 'payment-status'],
      ['GET', 'payment-attempt'],
      ['POST', 'refund'],
      ['POST', 'payment-attempt/refund'],
    ])
      await assert.rejects(
        controller.forward(request(method, `/api/v1/orders/${id}/${suffix}`), response()),
        (error) => error.getStatus() === 404,
      );
    assert.equal(received.length, 3);
  } finally {
    await upstream.close();
    await other.close();
  }
});

test('payment mutations enforce the session CSRF token and origin before contacting Payments', async () => {
  let forwarded = 0;
  const upstream = await server((_req, res) => {
    forwarded++;
    res.end('{}');
  });
  try {
    const authorization = auth(upstream.origin);
    authorization.config.PUBLIC_ORIGIN = 'https://eventflow.test';
    authorization.assertCsrf = AuthService.prototype.assertCsrf;
    const controller = new OrdersController(authorization, analyticsDisabled);
    for (const [origin, csrf] of [
      ['https://attacker.test', 'csrf-fixture'],
      ['https://eventflow.test', 'wrong'],
    ]) {
      const req = request('POST', `/api/v1/orders/${randomUUID()}/payment-attempt`, undefined, {});
      req.header = (name) => (name === 'origin' ? origin : csrf);
      await assert.rejects(
        controller.forward(req, response()),
        (error) => error.getStatus() === 403,
      );
    }
    assert.equal(forwarded, 0);
  } finally {
    await upstream.close();
  }
});

test('unknown payment responses remain retryable and never imply a successful payment', async () => {
  const upstream = await server((_req, res) => {
    res.statusCode = 202;
    res.end('{');
  });
  try {
    await assert.rejects(
      new OrdersController(auth(upstream.origin), analyticsDisabled).forward(
        request('POST', `/api/v1/orders/${randomUUID()}/payment-attempt`, undefined, {}),
        response(),
      ),
      (error) => error.getStatus() === 503 && error.getResponse().code === 'PAYMENTS_UNAVAILABLE',
    );
  } finally {
    await upstream.close();
  }
});

test('ticket QR proxy requires the approved route, trusted origin and PNG response', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const received = [];
  let contentType = 'image/png';
  let status = 200;
  const upstream = await server((req, res) => {
    received.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', contentType);
    res.statusCode = status;
    res.end(status === 200 ? png : '{"code":"NOT_FOUND"}');
  });
  try {
    const authService = auth('http://127.0.0.1:1');
    authService.config.TICKETS_URL = upstream.origin;
    const controller = new OrdersController(authService, analyticsDisabled);
    const path = `/api/v1/orders/${randomUUID()}/tickets/${randomUUID()}/qr`;
    const res = response();
    const headers = {};
    res.setHeader = (name, value) => {
      headers[name] = value;
    };
    res.end = (body) => {
      res.body = body;
    };
    await controller.forward(request('GET', path, 'http://127.0.0.1:1' + path), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, png);
    assert.equal(headers['cache-control'], 'no-store');
    assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
    await assert.rejects(
      controller.forward(request('POST', path), response()),
      (error) => error.getStatus() === 404,
    );
    await assert.rejects(
      controller.forward(request('GET', path + '/secret'), response()),
      (error) => error.getStatus() === 404,
    );
    assert.deepEqual(received, [{ path, auth: 'Bearer synthetic-access-token' }]);
    contentType = 'text/html';
    await assert.rejects(
      controller.forward(request('GET', path), response()),
      (error) => error.getStatus() === 503 && error.getResponse().code === 'TICKETS_UNAVAILABLE',
    );
    status = 404;
    contentType = 'application/json';
    const missing = response();
    await controller.forward(request('GET', path), missing);
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.body, { code: 'NOT_FOUND' });
  } finally {
    await upstream.close();
  }
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
    await new OrdersController(auth(trusted.origin), analyticsDisabled).forward(
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
      new OrdersController(auth(upstream.origin), analyticsDisabled).forward(
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
    const controller = new OrdersController(auth(upstream.origin), analyticsDisabled);
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
