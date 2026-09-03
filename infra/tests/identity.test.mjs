import assert from 'node:assert/strict';
import test from 'node:test';

test('Keycloak exposes the seeded issuer and grants a scoped machine identity', async () => {
  const response = await fetch(`${process.env.OIDC_ISSUER}/.well-known/openid-configuration`);
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.issuer, process.env.OIDC_ISSUER);
  const token = await fetch(metadata.token_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'eventflow-policy',
      client_secret: process.env.POLICY_CLIENT_SECRET,
    }),
  });
  assert.equal(token.status, 200);
  const body = await token.json();
  assert.ok(body.access_token);
  const rejected = await fetch(metadata.token_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: process.env.OIDC_CLIENT_ID,
      client_secret: process.env.OIDC_CLIENT_SECRET,
      username: 'owner',
      password: 'incorrect',
    }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'unauthorized_client');
});
