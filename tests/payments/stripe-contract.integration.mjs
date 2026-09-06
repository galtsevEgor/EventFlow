import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { createApplication } from '../../packages/service-runtime/dist/index.js';
import { stripeContract } from '../helpers/stripe-contract.mjs';
import { paymentsDatabase } from '../helpers/payments-database.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { StripePaymentProvider } from '../../services/payments/dist/providers/stripe.js';
import {
  ProviderMismatch,
  ProviderUnavailable,
} from '../../services/payments/dist/providers/provider.js';
import { AppModule } from '../../services/payments/dist/app.module.js';
import { Reconciler } from '../../services/payments/dist/reconciler.js';
import { ProcessWebhooks } from '../../services/payments/dist/webhooks/process.js';
import { readPaymentsConfig } from '../../services/payments/dist/config.js';
import { CreateAttempt } from '../../services/payments/dist/attempts/create.js';
import { ReadPayment } from '../../services/payments/dist/attempts/read.js';

let fixture, provider, persistence, app, origin;
const namespace = `eventflow-test-${randomUUID()}`;
before(async () => {
  fixture = await stripeContract();
  provider = new StripePaymentProvider(fixture.secret, fixture.signingSecret, fixture.client);
  persistence = await paymentsDatabase();
  const module = AppModule.configure({
    PAYMENTS_DATABASE_URL: persistence.url,
    AMQP_URL: process.env.AMQP_URL,
    MESSAGE_NAMESPACE: namespace,
    OIDC_ISSUER: process.env.OIDC_ISSUER,
    BOOKING_URL: 'http://127.0.0.1:1',
    PAYMENTS_CLIENT_SECRET: 'synthetic-machine-identity-secret',
    PAYMENT_PROVIDER: 'stripe',
    STRIPE_SECRET_KEY: fixture.secret,
    STRIPE_PUBLISHABLE_KEY: 'pk_test_synthetic',
    STRIPE_WEBHOOK_SECRET: fixture.signingSecret,
  });
  module.providers.find((p) => p.provide === 'PAYMENT_PROVIDER').useFactory = () => provider;
  app = await createApplication(module, { rawBody: true });
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
  await app.get(Reconciler).stop();
});
after(async () => {
  await app?.close();
  await persistence?.close();
  await fixture?.close();
  await cleanBroker(namespace);
});

test('buyer payment status exposes only the sandbox publishable key and checks ownership', async (t) => {
  const attempt = await persistence.db.paymentAttempt.create({
    data: {
      id: randomUUID(),
      orderId: randomUUID(),
      buyerSubject: 'stripe-buyer',
      amountMinor: 1500,
      currency: 'EUR',
      expiresAt: new Date(Date.now() + 300000),
      provider: 'stripe',
    },
  });
  t.after(() => persistence.db.paymentAttempt.delete({ where: { id: attempt.id } }));
  const reader = app.get(ReadPayment);
  const status = await reader.run(attempt.orderId, 'stripe-buyer');
  assert.equal(status.publishableKey, 'pk_test_synthetic');
  assert.equal(status.clientSecret, null);
  assert.equal(status.canPay, false);
  assert.equal(JSON.stringify(status).includes(fixture.secret), false);
  await assert.rejects(
    reader.run(attempt.orderId, 'other-buyer'),
    (error) => error.getStatus() === 404,
  );
});

test('Stripe request contract pins API version, card methods, authoritative price and stable keys', async () => {
  const first = await provider.create(fixture.input),
    second = await provider.create(fixture.input);
  assert.deepEqual(first, second);
  const requests = fixture.state.requests.slice(-2);
  assert.equal(requests[0].key, `eventflow:payment:${fixture.input.attemptId}`);
  assert.equal(requests[1].key, requests[0].key);
  assert.equal(requests[0].version, '2026-09-30.endive');
  assert.equal(requests[0].fields.amount, String(fixture.input.amountMinor));
  assert.equal(requests[0].fields.currency, 'eur');
  assert.deepEqual(
    Object.entries(requests[0].fields)
      .filter(([k]) => k.startsWith('allowed_payment_method_types'))
      .map(([, v]) => v),
    ['card'],
  );
  assert.equal(requests[0].fields.capture_method, 'automatic');
  assert.equal(requests[0].fields['metadata[orderId]'], fixture.input.orderId);
});

test('cancel race re-reads provider truth; invalid success, live mode and transport failure never become success', async () => {
  fixture.state.failCancel = true;
  fixture.state.payment.status = 'processing';
  assert.equal((await provider.cancel(fixture.state.payment.id)).status, 'processing');
  fixture.state.payment.status = 'succeeded';
  await assert.rejects(provider.retrieve(fixture.state.payment.id), ProviderMismatch);
  fixture.state.payment.amount_received = fixture.input.amountMinor;
  assert.equal((await provider.cancel(fixture.state.payment.id)).status, 'succeeded');
  fixture.state.payment.livemode = true;
  await assert.rejects(provider.retrieve(fixture.state.payment.id), ProviderMismatch);
  fixture.state.payment.livemode = false;
  fixture.state.failRequest = true;
  await assert.rejects(provider.retrieve(fixture.state.payment.id), ProviderUnavailable);
  fixture.state.failRequest = false;
});

test('refunds use a stable operation key and discovery refuses unrelated refunds', async () => {
  const input = {
    operationId: randomUUID(),
    paymentId: fixture.state.payment.id,
    amountMinor: fixture.input.amountMinor,
  };
  assert.equal(await provider.findRefund(input), null);
  const result = await provider.refund(input);
  assert.equal(result.status, 'succeeded');
  assert.equal(fixture.state.requests.at(-1).key, `eventflow:refund:${input.operationId}`);
  assert.deepEqual(await provider.findRefund(input), result);
  await assert.rejects(
    provider.findRefund({ ...input, operationId: randomUUID() }),
    ProviderMismatch,
  );
});

const event = (overrides = {}) => ({
  id: `evt_${randomUUID().replaceAll('-', '')}`,
  object: 'event',
  livemode: false,
  type: 'payment_intent.succeeded',
  data: { object: fixture.state.payment },
  ...overrides,
});
async function send(raw, signature = fixture.sign(raw)) {
  return fetch(origin + '/api/v1/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: raw,
  });
}

test('webhook verifies exact raw bytes, timestamp and sandbox before durable acknowledgement', async () => {
  const payload = JSON.stringify(event(), null, 2);
  assert.equal((await send(payload, 'forged')).status, 400);
  assert.equal((await send(payload + ' ', fixture.sign(payload))).status, 400);
  assert.equal(
    (await send(payload, fixture.sign(payload, Math.floor(Date.now() / 1000) - 600))).status,
    400,
  );
  assert.equal((await send(JSON.stringify(event({ livemode: true })))).status, 400);
  assert.equal((await send(JSON.stringify(event({ account: 'acct_untrusted' })))).status, 400);
  assert.equal((await send(JSON.stringify(event({ type: 'customer.created' })))).status, 400);
  assert.equal(await persistence.db.providerWebhook.count(), 0);
  const duplicates = await Promise.all(Array.from({ length: 12 }, () => send(payload)));
  assert.ok(duplicates.every((response) => response.status === 200));
  assert.equal((await send(payload)).status, 200);
  const rows = await persistence.db.providerWebhook.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].processedAt, null);
  assert.ok(!JSON.stringify(rows).includes('synthetic-client-secret'));
  assert.equal(await persistence.db.outbox.count(), 0);
  const changed = JSON.parse(payload);
  changed.data.object.id = 'pi_different';
  assert.equal((await send(JSON.stringify(changed))).status, 400);
});

test('an unknown signed payment becomes a review receipt without creating an attempt or a success event', async () => {
  await app.get(ProcessWebhooks).run();
  const receipt = await persistence.db.providerWebhook.findFirst();
  assert.equal(receipt.reviewCode, 'UNKNOWN_OR_MISMATCHED_PAYMENT');
  assert.ok(receipt.processedAt);
  assert.equal(await persistence.db.paymentAttempt.count(), 0);
  assert.equal(await persistence.db.outbox.count(), 0);
});

test('live keys and incomplete Stripe configuration are rejected at startup', () => {
  const base = {
    ...process.env,
    PAYMENT_PROVIDER: 'stripe',
    STRIPE_SECRET_KEY: fixture.secret,
    STRIPE_WEBHOOK_SECRET: fixture.signingSecret,
    STRIPE_PUBLISHABLE_KEY: 'pk_test_synthetic',
  };
  assert.equal(readPaymentsConfig(base).PAYMENT_PROVIDER, 'stripe');
  assert.throws(() => readPaymentsConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_forbidden' }));
  assert.throws(() => readPaymentsConfig({ ...base, STRIPE_WEBHOOK_SECRET: '' }));
});

test('webhook API lookup recovers a lost provider ID after key expiry without trusting webhook success', async () => {
  await persistence.db.paymentAttempt.create({
    data: {
      id: fixture.input.attemptId,
      orderId: fixture.input.orderId,
      buyerSubject: 'synthetic-buyer',
      amountMinor: fixture.input.amountMinor,
      currency: 'EUR',
      provider: 'stripe',
      authorized: true,
      expiresAt: new Date(Date.now() - 1000),
      createdAt: new Date(Date.now() - 24 * 3600_000),
      state: 'NEEDS_RECONCILIATION',
    },
  });
  assert.equal((await send(JSON.stringify(event()))).status, 200);
  await app.get(ProcessWebhooks).run();
  const attempt = await persistence.db.paymentAttempt.findUnique({
    where: { id: fixture.input.attemptId },
  });
  assert.equal(attempt.providerPaymentId, fixture.state.payment.id);
  assert.equal(attempt.successPublished, false);
  assert.equal(attempt.state, 'NEEDS_RECONCILIATION');
  assert.equal(await persistence.db.outbox.count(), 0);
});

test('unsupported small Stripe amounts are rejected before creating a durable attempt', async () => {
  const orderId = randomUUID();
  const snapshot = {
    orderId,
    buyerSubject: 'buyer',
    amountMinor: 1,
    currency: 'EUR',
    state: 'HELD',
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    serverNow: new Date().toISOString(),
  };
  const create = new CreateAttempt(persistence.db, { buyerOrder: async () => snapshot }, provider);
  await assert.rejects(
    create.run('buyer', orderId, randomUUID(), 'synthetic'),
    (error) => error.getStatus() === 422,
  );
  assert.equal(await persistence.db.paymentAttempt.count({ where: { orderId } }), 0);
});
