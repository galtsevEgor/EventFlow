import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { catalogFixture } from './fixture.mjs';
import { StatisticsConsumer } from '../dist/statistics/consumer.js';
import { message } from '../../../packages/event-contracts/dist/index.js';

let fixture, org, foreign, owner, manager, staff, outsider, eventId, consumer;
async function event(organizationId) {
  const draft = await fixture.db.eventDraft.create({
    data: { organizationId, title: 'Statistics event' },
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
  return draft.id;
}
async function order(state, count, expiresAt = new Date(Date.now() + 3600000).toISOString()) {
  const id = randomUUID();
  await consumer.handle(
    message('booking', 'OrderStatisticsChanged.v1', id, state === 'HELD' ? 1 : 2, {
      orderId: id,
      saleId: eventId,
      organizationId: org.id,
      state,
      seatCount: count,
      totalMinor: 5000,
      currency: 'EUR',
      createdAt: '2026-11-05T10:00:00.000Z',
      expiresAt,
      confirmedAt: state === 'CONFIRMED' ? '2026-11-05T10:01:00.000Z' : null,
    }),
  );
  return id;
}
async function payment(orderId, amountMinor = 5000) {
  const attemptId = randomUUID();
  const data = {
    orderId,
    attemptId,
    providerPaymentId: 'fake-' + attemptId,
    buyerSubject: 'private-buyer',
    amountMinor,
    currency: 'EUR',
    verifiedAt: '2026-11-05T10:01:00.000Z',
    provider: 'fake',
  };
  await consumer.handle(message('payments', 'PaymentSucceeded.v1', orderId, 1, data));
  return data;
}
const report = (token = owner, query = 'from=2026-11-05&to=2026-11-05') =>
  fixture.request(`/api/v1/organizations/${org.id}/statistics?${query}`, token);

before(async () => {
  fixture = await catalogFixture();
  consumer = new StatisticsConsumer(fixture.db);
  org = await fixture.db.organization.create({
    data: { name: 'Statistics report', createdBy: 'stats-owner' },
  });
  foreign = await fixture.db.organization.create({
    data: { name: 'Other tenant', createdBy: 'other' },
  });
  for (const [userSubject, role] of [
    ['stats-owner', 'OWNER'],
    ['stats-manager', 'MANAGER'],
    ['stats-staff', 'STAFF'],
  ])
    await fixture.db.membership.create({
      data: { organizationId: org.id, userSubject, role, email: userSubject + '@eventflow.test' },
    });
  [owner, manager, staff, outsider] = await Promise.all(
    ['stats-owner', 'stats-manager', 'stats-staff', 'outsider'].map((sub) =>
      fixture.token({ sub }),
    ),
  );
  eventId = await event(org.id);
  await event(org.id);
  await payment(await order('CONFIRMED', 2));
  await order('HELD', 1);
  await order('HELD', 1, '2026-11-01T00:00:00.000Z');
  const cancelled = await payment(await order('CANCELLED', 1));
  const refund = message('payments', 'RefundSucceeded.v1', cancelled.orderId, 1, {
    orderId: cancelled.orderId,
    attemptId: cancelled.attemptId,
    providerPaymentId: cancelled.providerPaymentId,
    operationId: randomUUID(),
    providerRefundId: 'refunded',
    state: 'SUCCEEDED',
    code: null,
  });
  refund.occurredAt = '2026-11-06T00:00:00.000Z';
  await consumer.handle(refund);
  // A trusted but mismatched fact is never counted as this order's money.
  await payment(await order('CANCELLED', 1), 1);
});
after(async () => {
  await fixture?.close();
});

test('report separates confirmed revenue, received payments, completed refunds and current inventory', async () => {
  const result = await report();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(result.body.totals, {
    capacity: 12,
    soldSeats: 2,
    heldSeats: 1,
    availableSeats: 9,
    confirmedOrders: 1,
    revenueMinor: 5000,
    paidMinor: 10000,
    refundedMinor: 0,
    netMinor: 10000,
  });
  assert.deepEqual(result.body.series, [
    { date: '2026-11-05', confirmedOrders: 1, revenueMinor: 5000 },
  ]);
  assert.ok(result.body.lastUpdatedAt);
  assert.equal(JSON.stringify(result.body).includes('private-buyer'), false);
  const next = await report(owner, 'from=2026-11-06&to=2026-11-06');
  assert.equal(next.body.totals.refundedMinor, 5000);
  assert.equal(next.body.totals.netMinor, -5000);
  assert.equal(next.body.totals.revenueMinor, 0);
  assert.equal(next.body.totals.soldSeats, 2);
});

test('pagination retains totals, event filters are scoped and empty dates form a complete series', async () => {
  const first = await report(owner, 'from=2026-11-04&to=2026-11-06&pageSize=1');
  const second = await report(owner, 'from=2026-11-04&to=2026-11-06&pageSize=1&page=2');
  assert.equal(first.body.total, 2);
  assert.equal(first.body.pages, 2);
  assert.notEqual(first.body.events[0].id, second.body.events[0].id);
  assert.deepEqual(first.body.totals, second.body.totals);
  assert.equal(first.body.series.length, 3);
  assert.equal(first.body.series[0].revenueMinor, 0);
  const scoped = await report(owner, `from=2026-11-05&to=2026-11-05&eventId=${eventId}`);
  assert.equal(scoped.body.total, 1);
  assert.equal(scoped.body.totals.capacity, 6);
  assert.equal((await report(owner, `eventId=${await event(foreign.id)}`)).status, 404);
  assert.equal((await report(owner, 'page=99')).body.events.length, 0);
});

test('only the current owner and manager roles can read their organization report', async () => {
  assert.equal((await report(manager)).status, 200);
  assert.equal((await report(staff)).status, 403);
  assert.equal((await report(outsider)).status, 404);
  assert.equal((await report('forged')).status, 401);
  await fixture.db.membership.update({
    where: { organizationId_userSubject: { organizationId: org.id, userSubject: 'stats-manager' } },
    data: { role: 'STAFF' },
  });
  assert.equal((await report(manager)).status, 403);
});

test('invalid, duplicated and excessively broad filter values are rejected', async () => {
  for (const query of [
    'from=2026-11-06&to=2026-11-05',
    'from=2020-01-01&to=2026-11-05',
    'from=invalid',
    'from=2026-11-05&from=2026-11-06',
    'pageSize=51',
    'eventId=invalid',
  ])
    assert.equal((await report(owner, query)).status, 422, query);
});
