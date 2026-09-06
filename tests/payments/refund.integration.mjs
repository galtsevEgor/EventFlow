import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { paymentsFixture } from '../helpers/payments.mjs';
import { pendingRefund } from '../helpers/payment-flow.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { ProcessRefund } from '../../services/payments/dist/refunds/process.js';
import { FakePaymentProvider } from '../../services/payments/dist/providers/fake.js';
import { randomUUID } from 'node:crypto';
import { RefundOutcome } from '../../services/booking/dist/payments/refund-outcome.js';
import { message } from '../../packages/event-contracts/dist/index.js';
let fixture, refunds;
before(async () => {
  fixture = await paymentsFixture();
  refunds = fixture.app.get(ProcessRefund);
});
after(async () => {
  await fixture?.close();
});
async function wake(id) {
  await fixture.db.refundOperation.update({ where: { id }, data: { nextRunAt: new Date(0) } });
}

test('concurrent compensation workers refund the full amount once and notify Booking', async () => {
  const { order, attempt, refund } = await pendingRefund(fixture);
  await Promise.all(Array.from({ length: 12 }, () => refunds.run(refund.id)));
  const saved = await fixture.db.refundOperation.findUnique({ where: { id: refund.id } });
  assert.equal(saved.state, 'SUCCEEDED');
  assert.equal(
    (await fixture.db.paymentAttempt.findUnique({ where: { id: attempt.id } })).bookingState,
    'REFUNDED',
  );
  assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
  assert.equal(
    (await fixture.db.fakeRefund.findUnique({ where: { operationId: refund.id } })).amountMinor,
    order.totalMinor,
  );
  const result = await eventually(
    () => fixture.booking.db.paymentResult.findUnique({ where: { operationId: refund.id } }),
    (p) => p.refundState === 'SUCCEEDED',
  );
  assert.equal(result.disposition, 'REFUND');
  assert.equal(
    (await fixture.booking.db.order.findUnique({ where: { id: order.id } })).state,
    'EXPIRED',
  );
});

test('lost refund response remains UNKNOWN, then restart discovers the existing refund', async () => {
  const { refund } = await pendingRefund(fixture);
  fixture.provider.inject('refund', { loseResponse: true });
  await refunds.run(refund.id);
  assert.equal(
    (await fixture.db.refundOperation.findUnique({ where: { id: refund.id } })).state,
    'UNKNOWN',
  );
  const restarted = new ProcessRefund(fixture.db, new FakePaymentProvider(fixture.db));
  await wake(refund.id);
  await restarted.run(refund.id);
  assert.equal(
    (await fixture.db.refundOperation.findUnique({ where: { id: refund.id } })).state,
    'SUCCEEDED',
  );
  assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
  assert.equal(
    (await fixture.db.outbox.findMany()).filter(
      (e) =>
        e.envelope.eventType === 'RefundSucceeded.v1' && e.envelope.data.operationId === refund.id,
    ).length,
    1,
  );
});

test('unresolved operation beyond the provider key lifetime requires review instead of recreating a refund', async () => {
  const { refund } = await pendingRefund(fixture);
  await fixture.db.refundOperation.update({
    where: { id: refund.id },
    data: { createdAt: new Date(Date.now() - 24 * 3600_000) },
  });
  await refunds.run(refund.id);
  assert.equal(
    (await fixture.db.refundOperation.findUnique({ where: { id: refund.id } })).state,
    'REQUIRES_REVIEW',
  );
  assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: refund.id } }), 0);
});

test('provider pending and failed refunds never appear as completed', async () => {
  const { refund, attempt } = await pendingRefund(fixture);
  const input = {
    operationId: refund.id,
    paymentId: attempt.providerPaymentId,
    amountMinor: refund.amountMinor,
  };
  const providerRefund = await fixture.provider.refund(input);
  await fixture.db.fakeRefund.update({
    where: { id: providerRefund.id },
    data: { status: 'pending' },
  });
  await refunds.run(refund.id);
  assert.equal(
    (await fixture.db.refundOperation.findUnique({ where: { id: refund.id } })).state,
    'PENDING',
  );
  await fixture.db.fakeRefund.update({
    where: { id: providerRefund.id },
    data: { status: 'failed' },
  });
  await wake(refund.id);
  await refunds.run(refund.id);
  assert.equal(
    (await fixture.db.refundOperation.findUnique({ where: { id: refund.id } })).state,
    'REQUIRES_REVIEW',
  );
  await eventually(
    () => fixture.booking.db.paymentResult.findUnique({ where: { operationId: refund.id } }),
    (p) => p.refundState === 'REQUIRES_REVIEW',
  );
});

test('expired worker lease is recovered and a stale failure cannot overwrite completed compensation', async () => {
  const { refund } = await pendingRefund(fixture);
  await fixture.db.refundOperation.update({
    where: { id: refund.id },
    data: {
      lease: randomUUID(),
      leaseUntil: new Date(Date.now() + 60_000),
    },
  });
  assert.equal(await refunds.run(refund.id), false);
  await fixture.db.refundOperation.update({
    where: { id: refund.id },
    data: { leaseUntil: new Date(0) },
  });
  assert.equal(await refunds.run(refund.id), true);
  await eventually(
    () => fixture.booking.db.paymentResult.findUnique({ where: { operationId: refund.id } }),
    (p) => p.refundState === 'SUCCEEDED',
  );
  const stale = message('payments', 'RefundFailed.v1', refund.orderId, 1, {
    orderId: refund.orderId,
    attemptId: refund.attemptId,
    operationId: refund.id,
    providerPaymentId: refund.providerPaymentId,
    providerRefundId: null,
    state: 'REQUIRES_REVIEW',
    code: 'STALE_FAILURE',
  });
  await new RefundOutcome(fixture.booking.db).handle(stale);
  assert.equal(
    (await fixture.booking.db.paymentResult.findUnique({ where: { operationId: refund.id } }))
      .refundState,
    'SUCCEEDED',
  );
  assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
});
