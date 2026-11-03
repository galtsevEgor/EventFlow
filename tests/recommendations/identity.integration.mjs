import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientCredentials, TokenVerifier } from '../../packages/service-runtime/dist/index.js';
test('the real recommendations machine has only its scoped Catalog feed permission', async () => {
  const client = new ClientCredentials(
    process.env.OIDC_ISSUER,
    'eventflow-recommendations',
    process.env.RECOMMENDATIONS_CLIENT_SECRET,
  );
  const token = await client.token(),
    verifier = new TokenVerifier(process.env.OIDC_ISSUER, 'eventflow-catalog');
  assert.ok(
    (
      await verifier.service(
        'Bearer ' + token,
        'eventflow-recommendations',
        'recommendations-index',
      )
    ).subject,
  );
  await assert.rejects(verifier.service('Bearer ' + token, 'eventflow-search', 'search-index'));
  await assert.rejects(verifier.user('Bearer ' + token));
});
