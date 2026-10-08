import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenVerifier } from '../dist/index.js';
import { testIdentity } from '../../../tests/helpers/identity.mjs';

test('operator permissions require a verified human, correct audience and independent read/recovery roles', async () => {
  const identity = await testIdentity();
  const verifier = new TokenVerifier(identity.issuer, 'eventflow-payments');
  const token = (claims) =>
    identity.token('human-operator', { aud: 'eventflow-payments', ...claims });
  try {
    const viewer = await token({ realm_access: { roles: ['ops-view'] } });
    assert.deepEqual(await verifier.operator(`Bearer ${viewer}`), {
      subject: 'human-operator',
      canRecover: false,
    });
    await assert.rejects(
      verifier.operator(`Bearer ${viewer}`, true),
      (error) => error.getStatus() === 403,
    );
    const operator = await token({ realm_access: { roles: ['ops-view', 'ops-recover'] } });
    assert.equal((await verifier.operator(`Bearer ${operator}`, true)).canRecover, true);
    for (const iat of [Math.floor(Date.now() / 1000) - 301, Math.floor(Date.now() / 1000) + 60])
      await assert.rejects(
        verifier.operator(`Bearer ${await token({ iat, realm_access: { roles: ['ops-view'] } })}`),
        (error) => error.getStatus() === 401,
      );
    for (const claims of [
      {},
      { realm_access: { roles: ['ops-recover'] } },
      { realm_access: { roles: ['ops-view'] }, azp: 'eventflow-operator' },
      { realm_access: { roles: ['ops-view'] }, email_verified: false },
      { realm_access: { roles: ['ops-view'] }, aud: 'foreign' },
    ]) {
      await assert.rejects(verifier.operator(`Bearer ${await token(claims)}`), (error) =>
        [401, 403].includes(error.getStatus()),
      );
    }
    await assert.rejects(
      verifier.operator(`Bearer ${operator.slice(0, -8)}forged`),
      (error) => error.getStatus() === 401,
    );
  } finally {
    await identity.close();
  }
});
