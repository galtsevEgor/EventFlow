import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ProcessAttempt } from '../../services/payments/dist/attempts/process.js';
import {
  paymentRetryAt,
  providerResendWindowExpired,
} from '../../services/payments/dist/processing-policy.js';
import { ProviderUnavailable } from '../../services/payments/dist/providers/provider.js';
import { Reconciler } from '../../services/payments/dist/reconciler.js';
import { ProcessRefund } from '../../services/payments/dist/refunds/process.js';
import { ProcessWebhooks } from '../../services/payments/dist/webhooks/process.js';
import { paymentsDatabase } from '../helpers/payments-database.mjs';

test('Payments uses exponential retry up to one minute and stops resending at 23 hours', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  for (const [failures, delay] of [
    [0, 1_000],
    [1, 2_000],
    [5, 32_000],
    [6, 60_000],
    [7, 60_000],
  ])
    assert.equal(+paymentRetryAt(failures, now), now + delay);
  const boundary = now - 23 * 60 * 60 * 1_000;
  assert.equal(providerResendWindowExpired(new Date(boundary + 1), now), false);
  assert.equal(providerResendWindowExpired(new Date(boundary), now), true);
  assert.equal(providerResendWindowExpired(new Date(boundary - 1), now), true);
});

test('attempt, refund and webhook workers retry with six previous failures and review with seven', async (context) => {
  const { db, close } = await paymentsDatabase();
  context.after(close);
  const paymentData = {
    buyerSubject: 'test-buyer',
    amountMinor: 2_500,
    currency: 'EUR',
    provider: 'fake',
    authorized: true,
    expiresAt: new Date(Date.now() + 600_000),
    nextRunAt: new Date(0),
  };
  const attempt = await db.paymentAttempt.create({
    data: { ...paymentData, id: randomUUID(), orderId: randomUUID(), failures: 6 },
  });
  const captured = await db.paymentAttempt.create({
    data: {
      ...paymentData,
      id: randomUUID(),
      orderId: randomUUID(),
      state: 'SUCCEEDED',
      successPublished: true,
      providerPaymentId: 'refund-payment',
    },
  });
  const refund = await db.refundOperation.create({
    data: {
      id: randomUUID(),
      attemptId: captured.id,
      orderId: captured.orderId,
      providerPaymentId: captured.providerPaymentId,
      amountMinor: captured.amountMinor,
      currency: captured.currency,
      reason: 'HOLD_EXPIRED',
      failures: 6,
      nextRunAt: new Date(0),
    },
  });
  const receipt = await db.providerWebhook.create({
    data: {
      eventId: 'test-retry',
      objectId: 'webhook-payment',
      type: 'payment_intent.succeeded',
      failures: 6,
      nextRunAt: new Date(0),
    },
  });
  const unavailable = async () => {
    throw new ProviderUnavailable();
  };
  const provider = {
    name: 'fake',
    create: unavailable,
    findRefund: unavailable,
    retrieve: unavailable,
  };
  const attempts = new ProcessAttempt(db, {}, provider);
  const refunds = new ProcessRefund(db, provider);
  const webhooks = new ProcessWebhooks(db, provider);
  const run = () => Promise.all([attempts.run(attempt.id), refunds.run(refund.id), webhooks.run()]);
  const read = () =>
    Promise.all([
      db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      db.refundOperation.findUniqueOrThrow({ where: { id: refund.id } }),
      db.providerWebhook.findUniqueOrThrow({ where: { eventId: receipt.eventId } }),
    ]);

  const startedAt = Date.now();
  await run();
  const retried = await read();
  const finishedAt = Date.now();
  for (const row of retried) {
    assert.equal(row.failures, 7);
    assert.equal(row.reviewCode, null);
    assert.ok(+row.nextRunAt >= startedAt + 60_000 && +row.nextRunAt <= finishedAt + 60_000);
  }
  assert.equal(retried[0].state, 'NEEDS_RECONCILIATION');
  assert.equal(retried[1].state, 'UNKNOWN');
  assert.equal(retried[2].processedAt, null);

  const due = { nextRunAt: new Date(0) };
  await Promise.all([
    db.paymentAttempt.update({ where: { id: attempt.id }, data: due }),
    db.refundOperation.update({ where: { id: refund.id }, data: due }),
    db.providerWebhook.update({ where: { eventId: receipt.eventId }, data: due }),
  ]);
  await run();
  const reviewed = await read();
  for (const row of reviewed) {
    assert.equal(row.failures, 8);
    assert.equal(row.reviewCode, 'RETRY_LIMIT');
  }
  assert.equal(reviewed[0].state, 'REQUIRES_REVIEW');
  assert.equal(reviewed[1].state, 'REQUIRES_REVIEW');
  assert.ok(reviewed[2].processedAt);
  await run();
  assert.deepEqual(await read(), reviewed);
});

test('a full refund pass leaves room for attempts and repeats after one second', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const worker = (kind) => ({
    run: async () => {
      calls.push(kind);
      return true;
    },
  });
  const reconciler = new Reconciler(worker('attempt'), worker('refund'), worker('webhook'));
  context.after(() => reconciler.stop());
  reconciler.start();
  context.mock.timers.tick(0);
  await setImmediate();
  const pass = ['webhook', ...Array(10).fill('refund'), ...Array(20).fill('attempt')];
  assert.deepEqual(calls, pass);
  context.mock.timers.tick(999);
  await setImmediate();
  assert.deepEqual(calls, pass);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(calls, [...pass, ...pass]);
});
