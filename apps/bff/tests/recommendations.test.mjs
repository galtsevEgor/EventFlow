import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { ApiError } from '@eventflow/service-runtime';
import { RecommendationsProxy } from '../dist/recommendations.controller.js';

const eventId = randomUUID();
const prefix = `/api/v1/events/${eventId}/similar`;
const hasError = (status, code) => (error) =>
  error.getStatus() === status && error.getResponse().code === code;

async function server(handle) {
  const app = createServer(handle);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${app.address().port}`,
    async close() {
      app.closeAllConnections();
      await new Promise((resolve) => app.close(resolve));
    },
  };
}

function page() {
  return {
    items: [
      {
        event: {
          id: randomUUID(),
          title: 'Jazz concert',
          description: 'Concert de jazz, джазовый концерт',
          city: 'Chisinau',
          address: 'Test street 1',
          timeZone: 'Europe/Chisinau',
          startsAt: '2030-12-10T16:00:00.000Z',
          endsAt: '2030-12-10T18:00:00.000Z',
          localDate: '2030-12-10',
          minPriceMinor: 1200,
          currency: 'EUR',
          capacity: 100,
          coverId: null,
        },
        reason: 'SIMILAR',
      },
    ],
    mode: 'similar',
    degraded: false,
  };
}

function auth(origin) {
  return {
    config: { RECOMMENDATIONS_URL: origin, RECOMMENDATIONS_ENABLED: 'true' },
    store: { rateLimit: async () => {} },
    requireSession: async () => {
      throw new Error('Public route must not request a session');
    },
    assertCsrf: () => {
      throw new Error('Public GET must not request CSRF');
    },
  };
}

function request() {
  const headers = {
    authorization: 'Bearer caller-private-token',
    cookie: 'private-browser-cookie',
    origin: 'https://attacker.invalid',
    'x-csrf-token': 'caller-csrf',
    'x-forwarded-host': 'attacker.invalid',
    'x-request-id': 'caller-request-id',
    traceparent: 'caller-trace',
  };
  return {
    method: 'GET',
    path: prefix,
    originalUrl: prefix,
    ip: '127.0.0.9',
    headers,
    header: (name) => headers[name],
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

function unavailable(error) {
  assert.equal(error.getStatus(), 503);
  const result = error.getResponse();
  assert.equal(result.code, 'RECOMMENDATIONS_UNAVAILABLE');
  for (const sensitive of ['private-upstream', 'caller-private', 'password', 'postgresql', 'stack'])
    assert.ok(!JSON.stringify(result).includes(sensitive));
  return true;
}

test('public similar route is GET, needs no session or CSRF, and forwards only server request/trace metadata', async () => {
  assert.equal(Reflect.getMetadata('method', RecommendationsProxy.prototype.similar), 0);
  assert.equal(
    Reflect.getMetadata('path', RecommendationsProxy.prototype.similar),
    'events/:id/similar',
  );
  const received = [];
  const fixture = page();
  const upstream = await server((req, res) => {
    received.push({ method: req.method, path: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(fixture));
  });
  try {
    const authorization = auth(upstream.origin);
    const limits = [];
    authorization.store.rateLimit = async (...args) => {
      limits.push(args);
    };
    const output = response();
    await new RecommendationsProxy(authorization).similar(eventId, request(), output);
    assert.equal(output.statusCode, 200);
    assert.deepEqual(output.body, fixture);
    assert.equal(output.headers['cache-control'], 'no-store');
    assert.deepEqual(limits, [['recommendations:127.0.0.9', 120]]);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'GET');
    assert.equal(received[0].path, prefix);
    assert.equal(received[0].headers['x-request-id'], output.locals.requestId);
    assert.equal(received[0].headers.traceparent, output.locals.traceparent);
    for (const header of ['authorization', 'cookie', 'origin', 'x-csrf-token', 'x-forwarded-host'])
      assert.equal(received[0].headers[header], undefined);
  } finally {
    await upstream.close();
  }
});

test('disabled flag, invalid event UUID, and rate limiting prevent upstream requests', async () => {
  let forwarded = 0;
  const upstream = await server((_req, res) => {
    forwarded++;
    res.end('{}');
  });
  try {
    const authorization = auth(upstream.origin);
    const controller = new RecommendationsProxy(authorization);
    authorization.config.RECOMMENDATIONS_ENABLED = 'false';
    await assert.rejects(
      controller.similar(eventId, request(), response()),
      hasError(404, 'NOT_FOUND'),
    );
    authorization.config.RECOMMENDATIONS_ENABLED = 'true';
    await assert.rejects(
      controller.similar('invalid-uuid', request(), response()),
      hasError(422, 'VALIDATION_FAILED'),
    );
    authorization.store.rateLimit = async () => {
      throw new ApiError(429, 'RATE_LIMITED', 'Slow down');
    };
    await assert.rejects(
      controller.similar(eventId, request(), response()),
      hasError(429, 'RATE_LIMITED'),
    );
    assert.equal(forwarded, 0);
  } finally {
    await upstream.close();
  }
});

test('absolute request targets preserve filters while pinning the configured upstream origin and path', async () => {
  let leaked = 0;
  const attacker = await server((_req, res) => {
    leaked++;
    res.end('{}');
  });
  const received = [];
  const fixture = page();
  const upstream = await server((req, res) => {
    received.push({ path: req.url, headers: req.headers });
    res.end(JSON.stringify(fixture));
  });
  try {
    const input = request();
    const query =
      '?city=Chisinau&from=2030-12-01&to=2030-12-31&minPriceMinor=0&maxPriceMinor=2000&limit=3';
    input.originalUrl = attacker.origin + '/steal-bearer' + query;
    await new RecommendationsProxy(auth(upstream.origin)).similar(eventId, input, response());
    assert.equal(leaked, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].path, prefix + query);
    assert.equal(received[0].headers.authorization, undefined);
  } finally {
    await upstream.close();
    await attacker.close();
  }
});

test('upstream redirects, malformed JSON, 5xx, and closed sockets become sanitized private 503 responses', async () => {
  let leaked = 0;
  const attacker = await server((_req, res) => {
    leaked++;
    res.end('{}');
  });
  let mode = 'redirect';
  const upstream = await server((req, res) => {
    if (mode === 'disconnect') {
      req.socket.destroy();
      return;
    }
    if (mode === 'redirect') {
      res.statusCode = 307;
      res.setHeader('location', attacker.origin + '/steal');
    } else if (typeof mode === 'number') res.statusCode = mode;
    res.end(
      mode === 'malformed'
        ? '{'
        : JSON.stringify({ diagnostic: 'private-upstream password postgresql stack' }),
    );
  });
  try {
    const controller = new RecommendationsProxy(auth(upstream.origin));
    for (mode of ['redirect', 'malformed', 500, 502, 503, 'disconnect']) {
      const output = response();
      await assert.rejects(controller.similar(eventId, request(), output), unavailable);
      assert.equal(output.headers['cache-control'], 'no-store');
      assert.equal(output.body, undefined);
    }
    assert.equal(leaked, 0);
  } finally {
    await upstream.close();
    await attacker.close();
  }
});

test('authoritative source 404 and 422 use fixed safe codes and discard private diagnostic bodies', async () => {
  let status = 404;
  const upstream = await server((_req, res) => {
    res.statusCode = status;
    res.end(JSON.stringify({ code: 'PRIVATE', diagnostic: 'private-upstream-token password' }));
  });
  try {
    const controller = new RecommendationsProxy(auth(upstream.origin));
    for (status of [404, 422]) {
      const output = response();
      await assert.rejects(controller.similar(eventId, request(), output), (error) => {
        assert.equal(error.getStatus(), status);
        assert.equal(error.getResponse().code, status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED');
        assert.ok(!JSON.stringify(error.getResponse()).includes('private-upstream'));
        assert.ok(!JSON.stringify(error.getResponse()).includes('password'));
        return true;
      });
      assert.equal(output.headers['cache-control'], 'no-store');
    }
  } finally {
    await upstream.close();
  }
});

test('strict response contract rejects private extras, wrong mode/reason, malformed documents and oversized lists', async () => {
  let fixture = page();
  const upstream = await server((_req, res) => {
    res.end(JSON.stringify(fixture));
  });
  try {
    const invalid = [];
    let malformed = page();
    malformed.privateProfile = { actor: 'private-upstream-actor' };
    invalid.push(malformed);
    malformed = page();
    malformed.items[0].privateScore = 0.95;
    invalid.push(malformed);
    malformed = page();
    malformed.items[0].event.email = 'private-upstream@example.invalid';
    invalid.push(malformed);
    malformed = page();
    malformed.mode = 'secret';
    invalid.push(malformed);
    malformed = page();
    malformed.items[0].reason = 'FAVORITES';
    invalid.push(malformed);
    malformed = page();
    malformed.mode = 'personal';
    malformed.items[0].reason = 'FAVORITES';
    invalid.push(malformed);
    malformed = page();
    malformed.items[0].event.startsAt = 'yesterday';
    invalid.push(malformed);
    malformed = page();
    delete malformed.items[0].event.coverId;
    invalid.push(malformed);
    malformed = page();
    malformed.items = Array.from({ length: 13 }, () => page().items[0]);
    invalid.push(malformed);
    const controller = new RecommendationsProxy(auth(upstream.origin));
    for (fixture of invalid) {
      const output = response();
      await assert.rejects(controller.similar(eventId, request(), output), unavailable);
      assert.equal(output.body, undefined);
      assert.equal(output.headers['cache-control'], 'no-store');
    }
    fixture = page();
    fixture.mode = 'upcoming';
    fixture.degraded = true;
    fixture.items[0].reason = 'UPCOMING';
    const output = response();
    await controller.similar(eventId, request(), output);
    assert.deepEqual(output.body, fixture);
  } finally {
    await upstream.close();
  }
});

test('404 and 422 cancel unfinished upstream bodies before returning safe errors', async () => {
  let status = 404;
  let cancelled;
  let resolveCancelled;
  const upstream = await server((_req, res) => {
    res.statusCode = status;
    res.on('close', () => resolveCancelled());
    res.write('private-upstream-diagnostic');
  });
  try {
    const controller = new RecommendationsProxy(auth(upstream.origin));
    for (status of [404, 422]) {
      cancelled = new Promise((resolve) => {
        resolveCancelled = resolve;
      });
      await assert.rejects(
        controller.similar(eventId, request(), response()),
        hasError(status, status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED'),
      );
      let timer;
      try {
        await Promise.race([
          cancelled,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Upstream body was not cancelled')), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await upstream.close();
  }
});
