import assert from 'node:assert/strict';
import test from 'node:test';
import { realtimeFixture } from '../helpers/realtime.mjs';
import { testIdentity } from '../helpers/identity.mjs';

test('BFF operator access uses signed roles and its session, never browser actor headers or machine tokens', async () => {
  const identity = await testIdentity();
  const fixture = await realtimeFixture({ OIDC_ISSUER: identity.issuer });
  try {
    const replica = await fixture.start();
    const request = (cookie) =>
      fetch(replica.origin + '/api/v1/ops/access', {
        headers: {
          ...(cookie ? { cookie } : {}),
          'x-operator-subject': 'operator',
          'x-operator-role': 'ops-recover',
        },
      });
    assert.equal((await request()).status, 401);
    for (const [roles, azp, expected] of [
      [[], 'eventflow-bff', 403],
      [['ops-view'], 'eventflow-bff', 200],
      [['ops-view', 'ops-recover'], 'eventflow-bff', 200],
      [['ops-view', 'ops-recover'], 'eventflow-operator', 403],
    ]) {
      const accessToken = await identity.token('human', {
        aud: 'eventflow-payments',
        azp,
        realm_access: { roles },
      });
      const id = await replica.store.create({
        user: { sub: 'human', email: 'human@eventflow.test', emailVerified: true, name: 'Human' },
        accessToken,
        refreshToken: 'synthetic-refresh',
        idToken: 'synthetic-id',
        csrf: 'x'.repeat(43),
        accessExpiresAt: Date.now() + 240000,
        absoluteExpiresAt: Date.now() + 3600000,
      });
      const response = await request(`eventflow_session=${id}`);
      assert.equal(response.status, expected);
      const body = await response.json();
      if (expected === 200) assert.deepEqual(body, { canRecover: roles.includes('ops-recover') });
      assert.ok(!JSON.stringify(body).includes(accessToken));
      await replica.store.destroy(id);
      assert.equal((await request(`eventflow_session=${id}`)).status, 401);
    }
  } finally {
    await fixture.close();
    await identity.close();
  }
});
