import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenVerifier } from '../../packages/service-runtime/dist/index.js';

async function token(client, secret) {
  const response = await fetch(`${process.env.OIDC_ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    body: new URLSearchParams({
      client_id: client,
      client_secret: secret,
      grant_type: 'client_credentials',
    }),
  });
  assert.equal(response.status, 200);
  return `Bearer ${(await response.json()).access_token}`;
}

test('real Keycloak payments identity has only its Booking audience and cannot impersonate a buyer', async () => {
  const auth = await token('eventflow-payments', process.env.PAYMENTS_CLIENT_SECRET);
  const verifier = new TokenVerifier(process.env.OIDC_ISSUER, 'eventflow-booking');
  assert.ok((await verifier.service(auth, 'eventflow-payments', 'booking-payments')).subject);
  await assert.rejects(verifier.user(auth));
  await assert.rejects(verifier.machine(auth));
  await assert.rejects(
    new TokenVerifier(process.env.OIDC_ISSUER, 'eventflow-catalog').service(
      auth,
      'eventflow-payments',
      'booking-payments',
    ),
  );
  const policy = await token('eventflow-policy', process.env.POLICY_CLIENT_SECRET);
  await assert.rejects(verifier.service(policy, 'eventflow-payments', 'booking-payments'));
});

test('real Keycloak operator identity is scoped to reconciliation in Payments', async () => {
  const auth = await token('eventflow-operator', process.env.PAYMENTS_OPERATOR_SECRET);
  const verifier = new TokenVerifier(process.env.OIDC_ISSUER, 'eventflow-payments');
  assert.ok((await verifier.service(auth, 'eventflow-operator', 'payments-reconcile')).subject);
  await assert.rejects(verifier.user(auth));
  await assert.rejects(
    new TokenVerifier(process.env.OIDC_ISSUER, 'eventflow-booking').service(
      auth,
      'eventflow-payments',
      'booking-payments',
    ),
  );
});
