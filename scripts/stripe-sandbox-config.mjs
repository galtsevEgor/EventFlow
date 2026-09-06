export function sandboxConfiguration(env) {
  if (
    !/^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY ?? '') ||
    !/^pk_test_[A-Za-z0-9]+$/.test(env.STRIPE_PUBLISHABLE_KEY ?? '')
  )
    throw new Error(
      'Stripe sandbox requires sk_test_ and pk_test_ keys; this test cannot be replaced with FakePaymentProvider.',
    );
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Stripe sandbox harness requires a loopback HTTP PUBLIC_ORIGIN.');
  return {
    secret: env.STRIPE_SECRET_KEY,
    publishable: env.STRIPE_PUBLISHABLE_KEY,
    webhookUrl: new URL('/api/v1/webhooks/stripe', origin).href,
  };
}
