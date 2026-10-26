import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ApiError } from '@eventflow/service-runtime';
import { OfflineCheckInProxy } from '../dist/offline-check-in.controller.js';
import { AuthService } from '../dist/auth/auth.service.js';

const prefix = '/api/v1/offline-check-in/';
const hasError = (status, code) => (error) =>
  error.getStatus() === status && error.getResponse().code === code;
async function server(handle) {
  const app = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    handle(req, res, body);
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
    config: { TICKETS_URL: origin, PUBLIC_ORIGIN: 'https://eventflow.test' },
    store: { rateLimit: async () => {} },
    assertCsrf: AuthService.prototype.assertCsrf,
    requireSession: async () => ({
      session: {
        user: { sub: 'staff-fixture', emailVerified: true },
        csrf: 'csrf-fixture',
        accessToken: 'synthetic-server-token',
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
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
    },
  };
}
function request(method, suffix, body) {
  const headers = {
    origin: 'https://eventflow.test',
    'x-csrf-token': 'csrf-fixture',
    authorization: 'Bearer attacker-token',
    cookie: 'private-browser-cookie',
    'x-request-id': 'attacker-request-id',
    traceparent: 'attacker-trace',
    'x-forwarded-host': 'attacker.test',
  };
  return {
    method,
    path: prefix + suffix,
    originalUrl: prefix + suffix,
    body,
    headers,
    header: (name) => headers[name],
  };
}

test('offline proxy admits only the three exact method/path pairs before reading the session', async () => {
  let authenticated = 0;
  const authorization = auth('http://127.0.0.1:1');
  authorization.requireSession = async () => {
    authenticated++;
    throw new Error('unexpected authentication');
  };
  const controller = new OfflineCheckInProxy(authorization);
  for (const [method, suffix] of [
    ['POST', 'keys'],
    ['GET', 'sessions'],
    ['GET', 'sync'],
    ['PUT', 'sync'],
    ['DELETE', 'sessions'],
    ['HEAD', 'keys'],
    ['OPTIONS', 'sync'],
    ['GET', 'keys/'],
    ['POST', 'sync/extra'],
    ['POST', '../check-in'],
    ['GET', 'unknown'],
  ])
    await assert.rejects(
      controller.forward(request(method, suffix), response()),
      hasError(404, 'NOT_FOUND'),
    );
  assert.equal(authenticated, 0);
});

test('authentication, email, CSRF origin/token and rate limit failures prevent any upstream request', async () => {
  let forwarded = 0;
  const upstream = await server((_req, res) => {
    forwarded++;
    res.end('{}');
  });
  try {
    const authorization = auth(upstream.origin);
    const controller = new OfflineCheckInProxy(authorization);
    const authenticated = authorization.requireSession;
    authorization.requireSession = async () => {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Login required');
    };
    await assert.rejects(
      controller.forward(request('GET', 'keys'), response()),
      hasError(401, 'UNAUTHENTICATED'),
    );
    authorization.requireSession = async () => {
      const current = await authenticated();
      current.session.user.emailVerified = false;
      return current;
    };
    await assert.rejects(
      controller.forward(request('GET', 'keys'), response()),
      hasError(403, 'EMAIL_UNVERIFIED'),
    );
    authorization.requireSession = authenticated;
    for (const suffix of ['sessions', 'sync']) {
      for (const headers of [
        { origin: 'https://attacker.test' },
        { 'x-csrf-token': 'incorrect-token' },
        { 'x-csrf-token': undefined },
        { origin: undefined },
      ]) {
        const input = request('POST', suffix, {});
        Object.assign(input.headers, headers);
        await assert.rejects(controller.forward(input, response()), hasError(403, 'CSRF_FAILED'));
      }
    }
    authorization.store.rateLimit = async () => {
      throw new ApiError(429, 'RATE_LIMITED', 'Slow down');
    };
    await assert.rejects(
      controller.forward(request('GET', 'keys'), response()),
      hasError(429, 'RATE_LIMITED'),
    );
    assert.equal(forwarded, 0);
  } finally {
    await upstream.close();
  }
});

test('all allowed routes use server bearer and trace headers, preserve bodies and disable caching', async () => {
  const received = [];
  const upstream = await server((req, res, body) => {
    received.push({ method: req.method, path: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ accepted: true }));
  });
  try {
    const authorization = auth(upstream.origin);
    const limits = [];
    authorization.store.rateLimit = async (...args) => {
      limits.push(args);
    };
    const controller = new OfflineCheckInProxy(authorization);
    for (const [method, suffix, body] of [
      ['GET', 'keys', undefined],
      [
        'POST',
        'sessions',
        { deviceId: randomUUID(), eventId: randomUUID(), organizationId: randomUUID() },
      ],
      ['POST', 'sync', { sessionId: randomUUID(), deviceId: randomUUID(), operations: [] }],
      ['POST', 'sync', undefined],
    ]) {
      const input = request(method, suffix, body),
        output = response();
      if (method === 'GET') {
        delete input.headers.origin;
        delete input.headers['x-csrf-token'];
      }
      await controller.forward(input, output);
      assert.equal(output.statusCode, 200);
      assert.deepEqual(output.body, { accepted: true });
      assert.equal(output.headers['cache-control'], 'no-store');
      const record = received.at(-1);
      assert.equal(record.path, prefix + suffix);
      assert.equal(record.method, method);
      assert.equal(record.body, method === 'GET' ? '' : JSON.stringify(body ?? {}));
      assert.equal(record.headers.authorization, 'Bearer synthetic-server-token');
      assert.equal(record.headers['content-type'], 'application/json');
      assert.equal(record.headers['x-request-id'], output.locals.requestId);
      assert.equal(record.headers.traceparent, output.locals.traceparent);
      for (const privateHeader of ['cookie', 'x-csrf-token', 'x-forwarded-host', 'origin'])
        assert.equal(record.headers[privateHeader], undefined);
    }
    assert.deepEqual(
      limits,
      Array.from({ length: 4 }, () => ['offline-gate:staff-fixture', 120]),
    );
  } finally {
    await upstream.close();
  }
});

test('absolute URLs and upstream redirects cannot send the server bearer to a different origin', async () => {
  let leaked = 0;
  const attacker = await server((_req, res) => {
    leaked++;
    res.end('{}');
  });
  const received = [];
  const trusted = await server((req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url.includes('redirect')) {
      res.statusCode = 307;
      res.setHeader('location', attacker.origin + '/steal');
    }
    res.end('{}');
  });
  try {
    const controller = new OfflineCheckInProxy(auth(trusted.origin));
    const input = request('GET', 'keys');
    input.originalUrl = attacker.origin + prefix + 'keys?version=1';
    await controller.forward(input, response());
    assert.deepEqual(received, [
      { path: prefix + 'keys?version=1', authorization: 'Bearer synthetic-server-token' },
    ]);
    const redirect = request('POST', 'sync', {});
    redirect.originalUrl = prefix + 'sync?redirect=1';
    const output = response();
    await assert.rejects(
      controller.forward(redirect, output),
      hasError(503, 'OFFLINE_GATE_UNAVAILABLE'),
    );
    assert.equal(output.headers['cache-control'], 'no-store');
    assert.equal(leaked, 0);
  } finally {
    await trusted.close();
    await attacker.close();
  }
});

test('authoritative 4xx responses preserve conflict details and remain private', async () => {
  let code = 409;
  const upstream = await server((_req, res) => {
    res.statusCode = code;
    res.end(JSON.stringify({ code: code === 409 ? 'IDEMPOTENCY_CONFLICT' : 'FORBIDDEN' }));
  });
  try {
    const controller = new OfflineCheckInProxy(auth(upstream.origin));
    for (code of [409, 403, 401, 400]) {
      const output = response();
      await controller.forward(request('POST', 'sync', {}), output);
      assert.equal(output.statusCode, code);
      assert.deepEqual(output.body, { code: code === 409 ? 'IDEMPOTENCY_CONFLICT' : 'FORBIDDEN' });
      assert.equal(output.headers['cache-control'], 'no-store');
    }
  } finally {
    await upstream.close();
  }
});

test('5xx, malformed acknowledgement and disconnected upstream are retryable without leaking upstream details', async () => {
  let mode = 500;
  const upstream = await server((req, res) => {
    if (mode === 'disconnect') {
      req.socket.destroy();
      return;
    }
    res.statusCode = typeof mode === 'number' ? mode : 200;
    res.end(
      mode === 'malformed' ? '{' : JSON.stringify({ internal: 'private-upstream-diagnostic' }),
    );
  });
  try {
    const controller = new OfflineCheckInProxy(auth(upstream.origin));
    for (mode of [500, 502, 503, 'malformed', 'disconnect']) {
      const output = response();
      await assert.rejects(
        controller.forward(request('POST', 'sync', { operations: [] }), output),
        (error) => {
          assert.equal(error.getStatus(), 503);
          assert.equal(error.getResponse().code, 'OFFLINE_GATE_UNAVAILABLE');
          assert.ok(!JSON.stringify(error.getResponse()).includes('private-upstream-diagnostic'));
          return true;
        },
      );
      assert.equal(output.body, undefined);
      assert.equal(output.headers['cache-control'], 'no-store');
    }
  } finally {
    await upstream.close();
  }
});
