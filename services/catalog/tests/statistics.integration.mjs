import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { catalogFixture } from './fixture.mjs';
import { StatisticsConsumer } from '../dist/statistics/consumer.js';
import { message } from '@eventflow/event-contracts';

let fixture, consumer, org, draft;
before(async () => {
  fixture = await catalogFixture();
  consumer = new StatisticsConsumer(fixture.db);
  org = await fixture.db.organization.create({
    data: { name: 'Statistics tests', createdBy: 'owner' },
  });
  draft = await fixture.db.eventDraft.create({
    data: { organizationId: org.id, title: 'Statistics concert' },
  });
});
after(async () => {
  await fixture?.close();
});

function snapshot(state = 'HELD', orderId = randomUUID()) {
  return message('booking', 'OrderStatisticsChanged.v1', orderId, state === 'HELD' ? 1 : 2, {
    orderId,
    saleId: draft.id,
    organizationId: org.id,
    state,
    seatCount: 2,
    totalMinor: 5000,
    currency: 'EUR',
    createdAt: '2026-11-05T10:00:00.000Z',
    expiresAt: '2026-11-05T10:10:00.000Z',
    confirmedAt: state === 'CONFIRMED' ? '2026-11-05T10:01:00.000Z' : null,
  });
}

test('terminal snapshots win over delayed holds and concurrent redelivery is atomic', async () => {
  const confirmed = snapshot('CONFIRMED');
  await Promise.all([consumer.handle(confirmed), consumer.handle(confirmed)]);
  await consumer.handle({ ...confirmed, eventId: randomUUID() });
  await consumer.handle(snapshot('HELD', confirmed.aggregateId));
  const row = await fixture.db.salesOrder.findUnique({ where: { orderId: confirmed.aggregateId } });
  assert.equal(row.state, 'CONFIRMED');
  assert.equal(row.version, 2);
  assert.equal(row.seatCount, 2);
  assert.equal(await fixture.db.salesOrder.count({ where: { orderId: confirmed.aggregateId } }), 1);
});

test('refund and payment facts survive reversed delivery and never duplicate amounts', async () => {
  const order = snapshot('CANCELLED'),
    attemptId = randomUUID(),
    operationId = randomUUID();
  const payment = message('payments', 'PaymentSucceeded.v1', order.aggregateId, 1, {
    orderId: order.aggregateId,
    attemptId,
    providerPaymentId: 'fake-' + attemptId,
    buyerSubject: 'private-buyer',
    amountMinor: 5000,
    currency: 'EUR',
    verifiedAt: '2026-11-05T10:11:00.000Z',
    provider: 'fake',
  });
  const refund = message('payments', 'RefundSucceeded.v1', order.aggregateId, 1, {
    orderId: order.aggregateId,
    attemptId,
    operationId,
    providerPaymentId: payment.data.providerPaymentId,
    providerRefundId: 'refund-' + operationId,
    state: 'SUCCEEDED',
    code: null,
  });
  await consumer.handle(refund);
  await consumer.handle(payment);
  await consumer.handle(order);
  await consumer.handle({
    ...payment,
    eventId: randomUUID(),
    eventType: 'PaymentStatisticsReplayed.v1',
  });
  await consumer.handle({
    ...refund,
    eventId: randomUUID(),
    eventType: 'RefundStatisticsReplayed.v1',
  });
  assert.equal(await fixture.db.salesPayment.count({ where: { attemptId } }), 1);
  assert.equal(await fixture.db.salesRefund.count({ where: { attemptId } }), 1);
  const row = await fixture.db.salesPayment.findUnique({ where: { attemptId } });
  assert.equal(row.amountMinor, 5000);
  assert.equal('buyerSubject' in row, false);
});

test('conflicting facts and forged producers roll back their inbox entry', async () => {
  const held = snapshot();
  await consumer.handle(held);
  const conflicting = { ...held, eventId: randomUUID(), data: { ...held.data, totalMinor: 1 } };
  await assert.rejects(consumer.handle(conflicting), /Conflicting statistics/);
  assert.equal(
    await fixture.db.inbox.findUnique({ where: { eventId: conflicting.eventId } }),
    null,
  );
  const terminal = snapshot('CONFIRMED', held.aggregateId);
  terminal.data.organizationId = randomUUID();
  await assert.rejects(consumer.handle(terminal), /Conflicting statistics/);
  await assert.rejects(
    consumer.handle({ ...held, eventId: randomUUID(), producer: 'payments' }),
    /Conflicting statistics/,
  );
  assert.equal(
    (await fixture.db.salesOrder.findUnique({ where: { orderId: held.aggregateId } })).totalMinor,
    5000,
  );
});

test('a failure after projection writes rolls everything back and restart applies the message', async () => {
  const event = snapshot();
  const failing = new StatisticsConsumer({
    $transaction: (run) =>
      fixture.db.$transaction(async (tx) => {
        await run(tx);
        throw new Error('injected failure before commit');
      }),
  });
  await assert.rejects(failing.handle(event), /injected failure/);
  assert.equal(
    await fixture.db.salesOrder.findUnique({ where: { orderId: event.aggregateId } }),
    null,
  );
  assert.equal(await fixture.db.inbox.findUnique({ where: { eventId: event.eventId } }), null);
  await new StatisticsConsumer(fixture.db).handle(event);
  assert.equal(
    (await fixture.db.salesOrder.findUnique({ where: { orderId: event.aggregateId } })).version,
    1,
  );
});
