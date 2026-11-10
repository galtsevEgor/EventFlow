import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { paymentsFixture } from '../helpers/payments.mjs';
import { paymentReplica } from '../helpers/payment-replica.mjs';
import { pendingRefund } from '../helpers/payment-flow.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { jsonRequest } from '../helpers/identity.mjs';
import { eventually } from '../helpers/eventually.mjs';

let fixture;
before(async () => {
  fixture = await paymentsFixture();
});
after(async () => {
  await fixture?.close();
});

async function databaseTime() {
  const [clock] = await fixture.db.$queryRaw`SELECT clock_timestamp() AS now`;
  return +clock.now;
}

async function assertLeaseDeadline(deadline, beforeClaim) {
  assert.ok(deadline);
  const claimedAt = deadline.getTime() - 60_000;
  assert.ok(claimedAt >= beforeClaim - 1 && claimedAt <= (await databaseTime()) + 1);
}

test('SIGKILL after provider create is recovered by another process with the original attempt and one payment', async () => {
  const buyer = await fixture.identity.token('crash-buyer', {
    aud: ['eventflow-booking', 'eventflow-payments'],
  });
  const sale = await seedSale(fixture.booking.db);
  const order = await jsonRequest(
    fixture.booking.origin,
    '/api/v1/orders',
    buyer,
    'POST',
    { saleId: sale.id, seatIds: ['r1-s1'] },
    randomUUID(),
  );
  assert.equal(order.status, 201);
  const created = await jsonRequest(
    fixture.origin,
    `/api/v1/orders/${order.body.id}/payment-attempt`,
    buyer,
    'POST',
    {},
    randomUUID(),
  );
  assert.equal(created.status, 202);
  const id = created.body.attemptId;
  const first = await paymentReplica(fixture);
  try {
    const beforeClaim = await databaseTime();
    await first.run('payment', id, true);
    const pending = await fixture.db.paymentAttempt.findUnique({ where: { id } });
    assert.ok(pending.lease);
    await assertLeaseDeadline(pending.leaseUntil, beforeClaim);
    assert.equal(pending.providerPaymentId, null);
    assert.equal(await fixture.db.fakePayment.count({ where: { attemptId: id } }), 1);
    await first.close(true);
    // Advance only the dead worker's lease; production waits for the same SQL deadline.
    await fixture.db.paymentAttempt.update({
      where: { id },
      data: { leaseUntil: new Date(0), nextRunAt: new Date(0) },
    });
    const second = await paymentReplica(fixture);
    try {
      assert.notEqual(first.pid, second.pid);
      await eventually(
        () => second.run('payment', id),
        (result) => result.claimed,
      );
      const recovered = await fixture.db.paymentAttempt.findUnique({ where: { id } });
      assert.equal(recovered.state, 'REQUIRES_ACTION');
      assert.ok(recovered.providerPaymentId);
      assert.equal(recovered.lease, null);
      assert.equal(await fixture.db.fakePayment.count({ where: { attemptId: id } }), 1);
    } finally {
      await second.close();
    }
  } finally {
    await first.close(true);
  }
});

test('SIGKILL after provider refund is recovered by another process with one full refund and one outcome event', async () => {
  const { refund, attempt } = await pendingRefund(fixture);
  const first = await paymentReplica(fixture);
  try {
    const beforeClaim = await databaseTime();
    await first.run('refund', refund.id, true);
    const pending = await fixture.db.refundOperation.findUnique({ where: { id: refund.id } });
    assert.ok(pending.lease);
    await assertLeaseDeadline(pending.leaseUntil, beforeClaim);
    assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
    await first.close(true);
    await fixture.db.refundOperation.update({
      where: { id: refund.id },
      data: { leaseUntil: new Date(0), nextRunAt: new Date(0) },
    });
    const second = await paymentReplica(fixture);
    try {
      assert.notEqual(first.pid, second.pid);
      await eventually(
        () => second.run('refund', refund.id),
        (result) => result.claimed,
      );
      const recovered = await fixture.db.refundOperation.findUnique({ where: { id: refund.id } });
      assert.equal(recovered.state, 'SUCCEEDED');
      assert.equal(recovered.lease, null);
      assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
      assert.equal(
        (await fixture.db.paymentAttempt.findUnique({ where: { id: attempt.id } })).bookingState,
        'REFUNDED',
      );
      const outcomes = await fixture.db.outbox.findMany({
        where: { envelope: { path: ['eventType'], equals: 'RefundSucceeded.v1' } },
      });
      assert.equal(outcomes.filter((row) => row.envelope.data.operationId === refund.id).length, 1);
    } finally {
      await second.close();
    }
  } finally {
    await first.close(true);
  }
});
