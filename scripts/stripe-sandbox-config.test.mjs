import assert from 'node:assert/strict';
import test from 'node:test';
import { sandboxConfiguration } from './stripe-sandbox-config.mjs';

test('sandbox harness rejects missing/live credentials and non-loopback forwarding before connecting', () => {
  const valid = {
    STRIPE_SECRET_KEY: 'sk_test_synthetic',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_synthetic',
    PUBLIC_ORIGIN: 'http://127.0.0.1:18000',
  };
  assert.equal(
    sandboxConfiguration(valid).webhookUrl,
    'http://127.0.0.1:18000/api/v1/webhooks/stripe',
  );
  for (const changes of [
    { STRIPE_SECRET_KEY: '' },
    { STRIPE_SECRET_KEY: 'sk_live_synthetic' },
    { STRIPE_PUBLISHABLE_KEY: 'pk_live_synthetic' },
    { PUBLIC_ORIGIN: 'https://attacker.invalid' },
    { PUBLIC_ORIGIN: 'http://localhost@attacker.invalid' },
    { PUBLIC_ORIGIN: 'http://127.0.0.1:18000/path' },
  ])
    assert.throws(() => sandboxConfiguration({ ...valid, ...changes }));
});
