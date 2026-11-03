import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { ApiError } from '@eventflow/service-runtime';
import { RecommendationsProxy } from '../dist/recommendations.controller.js';
import { AuthService } from '../dist/auth/auth.service.js';

const prefix = '/api/v1/recommendations/';
const eventId = randomUUID();
const hasError = (status, code) => (error) =>
  error.getStatus() === status && error.getResponse().code === code;

test('a stale browser actor cannot read or mutate a newly signed-in account', async () => {
  let forwarded = 0;
  const upstream = await server((_req, res) => {
    forwarded++;
    res.end(JSON.stringify(profile()));
  });
  try {
    const controller = new RecommendationsProxy(auth(upstream.origin));
    for (const method of ['GET', 'PUT']) {
      const input = request(method, 'profile', { revision: 0, interests: [] });
      input.headers['x-eventflow-actor'] = 'previous-account';
      await assert.rejects(
        controller.personal(input, response()),
        hasError(401, 'ACCOUNT_CHANGED'),
      );
    }
    assert.equal(forwarded, 0);
    const input = request('GET', 'profile');
    input.headers['x-eventflow-actor'] = 'buyer-fixture';
    const output = response();
    await controller.personal(input, output);
    assert.equal(output.headers['x-eventflow-actor'], 'buyer-fixture');
    assert.equal(forwarded, 1);
  } finally {
    await upstream.close();
  }
});

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

function profile() {
  return { revision: 2, interests: ['jazz'], favorites: [{ eventId, event: null }] };
}
function feed() {
  return { items: [], mode: 'personal', degraded: false };
}
function auth(origin) {
  return {
    config: {
      RECOMMENDATIONS_ENABLED: 'true',
      RECOMMENDATIONS_URL: origin,
      PUBLIC_ORIGIN: 'https://eventflow.test',
    },
    store: { rateLimit: async () => {} },
    assertCsrf: AuthService.prototype.assertCsrf,
    requireSession: async () => ({
      session: {
        user: { sub: 'buyer-fixture', emailVerified: true },
        csrf: 'csrf-fixture',
        accessToken: 'synthetic-server-token',
      },
    }),
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
    'x-forwarded-host': 'attacker.invalid',
  };
  return {
    method,
    path: prefix + suffix,
    originalUrl: prefix + suffix,
    ip: '127.0.0.9',
    body,
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
    statusCode: 200,
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
  assert.equal(error.getResponse().code, 'RECOMMENDATIONS_UNAVAILABLE');
  for (const secret of ['private-upstream', 'password', 'postgresql', 'synthetic-server-token'])
    assert.ok(!JSON.stringify(error.getResponse()).includes(secret));
  return true;
}

test('private recommendations admit exact method/path pairs and enabled flag before session lookup or forwarding', async () => {
  let forwarded = 0;
  const upstream = await server((_req, res) => {
    forwarded++;
    res.end('{}');
  });
  let authenticated = 0;
  try {
    const authorization = auth(upstream.origin);
    authorization.requireSession = async () => {
      authenticated++;
      throw new Error('unexpected session');
    };
    const controller = new RecommendationsProxy(authorization);
    for (const [method, suffix] of [
      ['POST', 'profile'],
      ['DELETE', 'profile'],
      ['PUT', 'me'],
      ['POST', 'me'],
      ['HEAD', 'me'],
      ['OPTIONS', 'profile'],
      ['GET', 'profile/'],
      ['GET', 'unknown'],
      ['POST', 'interests'],
      ['GET', `favorites/${eventId}`],
      ['POST', `favorites/${eventId}`],
      ['PUT', 'favorites/not-uuid'],
      ['PUT', `favorites/${eventId}/extra`],
      ['PUT', '../profile'],
    ]) {
      const output = response();
      await assert.rejects(
        controller.personal(request(method, suffix), output),
        hasError(404, 'NOT_FOUND'),
      );
      assert.equal(output.headers['cache-control'], 'no-store');
    }
    authorization.config.RECOMMENDATIONS_ENABLED = 'false';
    for (const suffix of ['profile', 'me', 'interests'])
      await assert.rejects(
        controller.personal(request('GET', suffix), response()),
        hasError(404, 'NOT_FOUND'),
      );
    assert.equal(authenticated, 0);
    assert.equal(forwarded, 0);
  } finally {
    await upstream.close();
  }
});

test('session, verified email, mutation CSRF and per-user rate limits fail before upstream requests', async () => {
  let forwarded = 0;
  const upstream = await server((_req, res) => {
    forwarded++;
    res.end('{}');
  });
  try {
    const authorization = auth(upstream.origin);
    const controller = new RecommendationsProxy(authorization);
    const authenticated = authorization.requireSession;
    authorization.requireSession = async () => {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Login required');
    };
    await assert.rejects(
      controller.personal(request('GET', 'profile'), response()),
      hasError(401, 'UNAUTHENTICATED'),
    );
    authorization.requireSession = async () => {
      const value = await authenticated();
      value.session.user.emailVerified = false;
      return value;
    };
    await assert.rejects(
      controller.personal(request('GET', 'me'), response()),
      hasError(403, 'EMAIL_UNVERIFIED'),
    );
    authorization.requireSession = authenticated;
    for (const [method, suffix] of [
      ['PUT', 'profile'],
      ['PUT', `favorites/${eventId}`],
      ['DELETE', `favorites/${eventId}`],
    ]) {
      for (const headers of [
        { origin: 'https://attacker.invalid' },
        { origin: undefined },
        { 'x-csrf-token': 'incorrect' },
        { 'x-csrf-token': undefined },
      ]) {
        const input = request(method, suffix, {});
        Object.assign(input.headers, headers);
        await assert.rejects(controller.personal(input, response()), hasError(403, 'CSRF_FAILED'));
      }
    }
    authorization.store.rateLimit = async () => {
      throw new ApiError(429, 'RATE_LIMITED', 'Slow down');
    };
    for (const suffix of ['profile', 'me', 'interests'])
      await assert.rejects(
        controller.personal(request('GET', suffix), response()),
        hasError(429, 'RATE_LIMITED'),
      );
    assert.equal(forwarded, 0);
  } finally {
    await upstream.close();
  }
});

test('allowed private requests use session bearer and server trace, preserve profile PUT body, and GET needs no CSRF', async () => {
  const received = [];
  const upstream = await server((req, res, body) => {
    received.push({ method: req.method, path: req.url, headers: req.headers, body });
    const result = req.url.endsWith('/me')
      ? feed()
      : req.url.endsWith('/interests')
        ? { interests: [{ id: 'jazz', title: 'Jazz' }] }
        : profile();
    res.end(JSON.stringify(result));
  });
  try {
    const authorization = auth(upstream.origin),
      limits = [];
    authorization.store.rateLimit = async (...args) => {
      limits.push(args);
    };
    const controller = new RecommendationsProxy(authorization);
    for (const [method, suffix, body] of [
      ['GET', 'profile'],
      ['PUT', 'profile', { revision: 2, interests: ['jazz', 'theatre'] }],
      ['GET', 'me'],
      ['PUT', `favorites/${eventId}`],
      ['DELETE', `favorites/${eventId}`],
    ]) {
      const input = request(method, suffix, body),
        output = response();
      if (method === 'GET') {
        delete input.headers.origin;
        delete input.headers['x-csrf-token'];
      }
      await controller.personal(input, output);
      assert.equal(output.headers['cache-control'], 'no-store');
      assert.deepEqual(output.body, suffix === 'me' ? feed() : profile());
      const record = received.at(-1);
      assert.equal(record.method, method);
      assert.equal(record.path, prefix + suffix);
      assert.equal(
        record.body,
        method === 'PUT' && suffix === 'profile' ? JSON.stringify(body) : '',
      );
      assert.equal(record.headers.authorization, 'Bearer synthetic-server-token');
      assert.equal(record.headers['x-request-id'], output.locals.requestId);
      assert.equal(record.headers.traceparent, output.locals.traceparent);
      assert.equal(record.headers['content-type'], 'application/json');
      for (const name of ['cookie', 'origin', 'x-csrf-token', 'x-forwarded-host'])
        assert.equal(record.headers[name], undefined);
    }
    assert.deepEqual(
      limits,
      Array.from({ length: 5 }, () => ['recommendations:user:buyer-fixture', 120]),
    );
    authorization.requireSession = async () => {
      throw new Error('Metadata must be anonymous');
    };
    const output = response();
    await controller.personal(request('GET', 'interests'), output);
    assert.deepEqual(output.body, { interests: [{ id: 'jazz', title: 'Jazz' }] });
    assert.equal(received.at(-1).headers.authorization, undefined);
    assert.deepEqual(limits.at(-1), ['recommendations:127.0.0.9', 120]);
  } finally {
    await upstream.close();
  }
});

test('absolute private request targets and redirects cannot exfiltrate session bearer while filter queries survive', async () => {
  let leaked = 0;
  const attacker = await server((_req, res) => {
    leaked++;
    res.end('{}');
  });
  let redirect = false;
  const received = [];
  const upstream = await server((req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization });
    if (redirect) {
      res.statusCode = 307;
      res.setHeader('location', attacker.origin + '/steal');
    }
    res.end(JSON.stringify(feed()));
  });
  try {
    const controller = new RecommendationsProxy(auth(upstream.origin));
    const input = request('GET', 'me');
    const query =
      '?city=Chisinau&from=2030-01-01&to=2030-12-31&minPriceMinor=0&maxPriceMinor=3000&limit=3';
    input.originalUrl = attacker.origin + '/steal' + query;
    await controller.personal(input, response());
    assert.deepEqual(received, [
      { path: prefix + 'me' + query, authorization: 'Bearer synthetic-server-token' },
    ]);
    redirect = true;
    await assert.rejects(controller.personal(request('GET', 'me'), response()), unavailable);
    assert.equal(leaked, 0);
  } finally {
    await upstream.close();
    await attacker.close();
  }
});

test('upstream private 401/403/404/409/422 responses become safe route-specific errors', async () => {
  let status = 401;
  const upstream = await server((_req, res) => {
    res.statusCode = status;
    res.end(JSON.stringify({ private: 'private-upstream password postgresql' }));
  });
  try {
    const controller = new RecommendationsProxy(auth(upstream.origin));
    for (const [code, expected] of [
      [401, 'UNAUTHENTICATED'],
      [403, 'EMAIL_UNVERIFIED'],
      [404, 'NOT_FOUND'],
      [409, 'PROFILE_CHANGED'],
      [422, 'VALIDATION_FAILED'],
    ]) {
      status = code;
      const output = response();
      await assert.rejects(
        controller.personal(request('PUT', 'profile', { revision: 1, interests: [] }), output),
        (error) => {
          assert.ok(hasError(code, expected)(error));
          assert.ok(!JSON.stringify(error.getResponse()).includes('private-upstream'));
          return true;
        },
      );
      assert.equal(output.body, undefined);
      assert.equal(output.headers['cache-control'], 'no-store');
    }
    status = 409;
    await assert.rejects(
      controller.personal(request('PUT', `favorites/${eventId}`), response()),
      hasError(409, 'FAVORITES_LIMIT'),
    );
  } finally {
    await upstream.close();
  }
});

test('upstream private 5xx, malformed JSON and socket failure produce sanitized no-store 503', async () => {
  let mode = 500;
  const upstream = await server((req, res) => {
    if (mode === 'disconnect') {
      req.socket.destroy();
      return;
    }
    res.statusCode = typeof mode === 'number' ? mode : 200;
    res.end(mode === 'malformed' ? '{' : JSON.stringify({ private: 'private-upstream password' }));
  });
  try {
    const controller = new RecommendationsProxy(auth(upstream.origin));
    for (mode of [500, 502, 503, 'malformed', 'disconnect']) {
      const output = response();
      await assert.rejects(controller.personal(request('GET', 'profile'), output), unavailable);
      assert.equal(output.headers['cache-control'], 'no-store');
      assert.equal(output.body, undefined);
    }
  } finally {
    await upstream.close();
  }
});

test('strict private response schemas reject profile extras, oversized favorites and wrong personal feed modes', async () => {
  let fixture = profile();
  const upstream = await server((_req, res) => {
    res.end(JSON.stringify(fixture));
  });
  try {
    const controller = new RecommendationsProxy(auth(upstream.origin));
    const invalid = [];
    let value = profile();
    value.actor = 'private-upstream-actor';
    invalid.push(['profile', value]);
    value = profile();
    value.favorites[0].privateTitle = 'private-upstream-title';
    invalid.push(['profile', value]);
    value = profile();
    value.favorites = Array.from({ length: 101 }, () => ({ eventId: randomUUID(), event: null }));
    invalid.push(['profile', value]);
    value = profile();
    value.revision = -1;
    invalid.push(['profile', value]);
    invalid.push([
      'interests',
      { interests: [{ id: 'jazz', title: 'Jazz', actor: 'private-upstream' }] },
    ]);
    invalid.push(['me', { ...feed(), mode: 'similar' }]);
    invalid.push(['me', { ...feed(), actor: 'private-upstream' }]);
    for (const [suffix, body] of invalid) {
      fixture = body;
      const output = response();
      await assert.rejects(controller.personal(request('GET', suffix), output), unavailable);
      assert.equal(output.body, undefined);
      assert.equal(output.headers['cache-control'], 'no-store');
    }
    fixture = { items: [], mode: 'upcoming', degraded: true };
    const output = response();
    await controller.personal(request('GET', 'me'), output);
    assert.deepEqual(output.body, fixture);
  } finally {
    await upstream.close();
  }
});
