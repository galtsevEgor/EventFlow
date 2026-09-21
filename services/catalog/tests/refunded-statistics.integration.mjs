import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogFixture } from './fixture.mjs';
import { StatisticsConsumer } from '../dist/statistics/consumer.js';
import { message } from '@eventflow/event-contracts';

test('confirmed refunds atomically restore availability and preserve gross history across reordering', async () => {
  const fixture = await catalogFixture();
  try {
    const org = await fixture.db.organization.create({
      data: { name: 'Refunded report', createdBy: 'owner' },
    });
    await fixture.db.membership.create({
      data: {
        organizationId: org.id,
        userSubject: 'owner',
        email: 'owner@eventflow.test',
        role: 'OWNER',
      },
    });
    const draft = await fixture.db.eventDraft.create({
      data: { organizationId: org.id, title: 'Refunded concert' },
    });
    await fixture.db.publicEvent.create({
      data: {
        eventId: draft.id,
        city: 'Кишинёв',
        address: 'Сцена, 1',
        timeZone: 'Europe/Chisinau',
        startsAt: '2035-06-01T16:00:00Z',
        endsAt: '2035-06-01T18:00:00Z',
        localDate: '2035-06-01',
        minPriceMinor: 2500,
        currency: 'EUR',
        capacity: 6,
      },
    });
    const consumer = new StatisticsConsumer(fixture.db),
      orderId = randomUUID(),
      attemptId = randomUUID(),
      operationId = randomUUID();
    const base = {
      orderId,
      saleId: draft.id,
      organizationId: org.id,
      state: 'CONFIRMED',
      seatCount: 2,
      totalMinor: 5000,
      currency: 'EUR',
      createdAt: '2026-11-05T10:00:00.000Z',
      expiresAt: '2026-11-05T10:10:00.000Z',
      confirmedAt: '2026-11-05T10:01:00.000Z',
    };
    const refunded = message('booking', 'OrderRefunded.v1', orderId, 3, {
      ...base,
      state: 'REFUNDED',
      operationId,
      attemptId,
      providerPaymentId: `fake_${attemptId}`,
      refundedAt: '2026-11-06T10:00:00.000Z',
    });
    const failing = new StatisticsConsumer({
      $transaction: (run) =>
        fixture.db.$transaction(async (tx) => {
          await run(tx);
          throw new Error('crash before commit');
        }),
    });
    await assert.rejects(failing.handle(refunded), /crash before commit/);
    assert.equal(await fixture.db.salesRefund.count(), 0);
    assert.equal(await fixture.db.salesOrder.count(), 0);
    await consumer.handle(refunded);
    await consumer.handle(message('booking', 'OrderStatisticsChanged.v1', orderId, 2, base));
    await consumer.handle({ ...refunded, eventId: randomUUID() });
    await consumer.handle(
      message('payments', 'PaymentSucceeded.v1', orderId, 1, {
        orderId,
        attemptId,
        providerPaymentId: `fake_${attemptId}`,
        buyerSubject: 'private',
        amountMinor: 5000,
        currency: 'EUR',
        provider: 'fake',
        verifiedAt: base.confirmedAt,
      }),
    );
    assert.equal((await fixture.db.salesOrder.findUnique({ where: { orderId } })).version, 3);
    assert.equal(await fixture.db.salesRefund.count({ where: { operationId } }), 1);
    const token = await fixture.token({ sub: 'owner' });
    const report = await fixture.request(
      `/api/v1/organizations/${org.id}/statistics?from=2026-11-05&to=2026-11-06`,
      token,
    );
    assert.equal(report.status, 200);
    assert.deepEqual(report.body.totals, {
      capacity: 6,
      soldSeats: 0,
      heldSeats: 0,
      availableSeats: 6,
      confirmedOrders: 1,
      revenueMinor: 5000,
      paidMinor: 5000,
      refundedMinor: 5000,
      netMinor: 0,
    });
    assert.deepEqual(report.body.series, [
      { date: '2026-11-05', confirmedOrders: 1, revenueMinor: 5000 },
      { date: '2026-11-06', confirmedOrders: 0, revenueMinor: 0 },
    ]);
    const conflict = {
      ...refunded,
      eventId: randomUUID(),
      data: { ...refunded.data, totalMinor: 1 },
    };
    await assert.rejects(consumer.handle(conflict), /Conflicting statistics/);
    assert.equal(await fixture.db.inbox.findUnique({ where: { eventId: conflict.eventId } }), null);
  } finally {
    await fixture.close();
  }
});
