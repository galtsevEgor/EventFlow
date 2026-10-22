import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AnalyticsSession } from '../dist/analytics/session.js';
import { AnalyticsBridge } from '../dist/analytics/service.js';
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
