import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AnalyticsSession } from '../dist/analytics/session.js';
import { AnalyticsBridge } from '../dist/analytics/service.js';
import { AnalyticsProxy } from '../dist/analytics/controller.js';
import { createServer } from 'node:http';
test('analytics cookies reject tampering and expiry without accepting caller session IDs', () => {
  const signer = new AnalyticsSession('a'.repeat(64)),
    value = { id: randomUUID(), expires: Date.now() + 60000 };
  const token = signer.sign(value);
  assert.deepEqual(signer.read({ headers: { cookie: 'eventflow_analytics=' + token } }), value);
  assert.equal(signer.read({ headers: { cookie: 'eventflow_analytics=' + token + 'x' } }), null);
  assert.equal(
    signer.read({
      headers: { cookie: 'eventflow_analytics=' + signer.sign({ ...value, expires: 1 }) },
    }),
    null,
  );
  assert.equal(new AnalyticsSession('b'.repeat(64)).verify(token), null);
  assert.equal(signer.verify('not-json.signature.extra'), null);
});
test('search attribution accepts only an unexpired signed result containing the event', () => {
  const bridge = new AnalyticsBridge({
    OIDC_ISSUER: 'http://127.0.0.1:1',
    OIDC_CLIENT_SECRET: 'a'.repeat(64),
    ANALYTICS_SESSION_KEY: 'b'.repeat(64),
  });
  const id = randomUUID(),
    event = randomUUID();
  const proof = bridge.session.sign({ id, events: [event], expires: Date.now() + 60000 });
  assert.equal(bridge.searchId(proof, event), id);
  assert.equal(bridge.searchId(proof, randomUUID()), null);
  assert.equal(bridge.searchId(proof + 'x', event), null);
  assert.equal(
    bridge.searchId(bridge.session.sign({ id, events: [event], expires: 1 }), event),
    null,
  );
});
test('absolute-form analytics URLs cannot receive the BFF bearer token on another origin', async () => {
  const received = [],
    leaked = [];
  const listen = async (rows) => {
    const server = createServer((req, res) => {
      rows.push({ path: req.url, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    return server;
  };
  const trusted = await listen(received),
    attacker = await listen(leaked);
  try {
    const path = '/api/v1/organizations/' + randomUUID() + '/analytics';
    const auth = {
      config: { ANALYTICS_URL: 'http://127.0.0.1:' + trusted.address().port },
      requireSession: async () => ({
        session: { user: { sub: 'buyer' }, accessToken: 'synthetic-server-token' },
      }),
      store: { rateLimit: async () => {} },
    };
    const controller = new AnalyticsProxy(auth, {});
    const response = {
      setHeader() {},
      status(value) {
        this.code = value;
        return this;
      },
      json(value) {
        this.body = value;
      },
    };
    await controller.report(
      {
        method: 'GET',
        path,
        originalUrl:
          'http://127.0.0.1:' + attacker.address().port + path + '?from=2026-11-09&to=2026-11-09',
      },
      response,
    );
    assert.equal(response.code, 200);
    assert.equal(leaked.length, 0);
    assert.deepEqual(received, [
      {
        path: path + '?from=2026-11-09&to=2026-11-09',
        authorization: 'Bearer synthetic-server-token',
      },
    ]);
  } finally {
    for (const server of [trusted, attacker]) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }
});
