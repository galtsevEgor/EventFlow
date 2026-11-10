import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test, mock } from 'node:test';
import { bookingFixture } from '../helpers/booking.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { testIdentity, jsonRequest } from '../helpers/identity.mjs';
import { ApiError } from '../../packages/service-runtime/dist/index.js';
import { ConfirmPayment } from '../../services/booking/dist/payments/confirm.js';
import { PaymentAuthorization } from '../../services/booking/dist/payments/authorization.js';
import { RefundAccess } from '../../services/booking/dist/refunds/access.js';
import { message } from '../../packages/event-contracts/dist/index.js';

const namespace = `eventflow-test-${randomUUID()}`;
let fixture,
  identity,
  buyer,
  allowed = true;
before(async () => {
  identity = await testIdentity();
  fixture = await bookingFixture(namespace, 0, { OIDC_ISSUER: identity.issuer });
  buyer = await identity.token();
  mock.method(fixture.app.get(RefundAccess), 'check', async (actor) => {
    if (!allowed || !['owner', 'manager'].includes(actor))
      throw new ApiError(403, 'FORBIDDEN', 'Forbidden');
  });
});
after(async () => {
  await fixture?.close();
  await identity?.close();
  await cleanBroker(namespace);
});
const request = (...args) => jsonRequest(fixture.origin, ...args);
async function confirmed() {
  const sale = await seedSale(fixture.db);
  const { body: order } = await request(
    '/api/v1/orders',
    buyer,
    'POST',
    { saleId: sale.id, seatIds: ['r1-s1', 'r1-s2'] },
    randomUUID(),
  );
  const attemptId = randomUUID();
  await fixture.app.get(PaymentAuthorization).authorize(order.id, attemptId, 'buyer', 'fake');
  await fixture.app.get(ConfirmPayment).handle(
    message('payments', 'PaymentSucceeded.v1', order.id, 1, {
      orderId: order.id,
      attemptId,
      providerPaymentId: `fake_${randomUUID()}`,
      buyerSubject: 'buyer',
      amountMinor: order.totalMinor,
      currency: 'EUR',
      provider: 'fake',
      verifiedAt: new Date().toISOString(),
    }),
  );
  const path = `/api/v1/organizations/${sale.organizationId}/events/${sale.id}/orders`;
  return { sale, order, path };
}

test('concurrent organizer retries persist one fence command and recheck access before replay', async () => {
  const { order, path } = await confirmed();
  const owner = await identity.token('owner'),
    key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      request(`${path}/${order.id}/refund`, owner, 'POST', { reason: 'Event cancelled' }, key),
    ),
  );
  assert.ok(
    results.every((r) => r.status === 202),
    JSON.stringify(results),
  );
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.equal(results[0].body.state, 'FENCING');
  assert.equal(await fixture.db.orderRefund.count({ where: { orderId: order.id } }), 1);
  const emitted = (await fixture.db.outbox.findMany()).filter(
    (r) =>
      r.envelope.eventType === 'TicketRefundLockRequested.v1' &&
      r.envelope.aggregateId === order.id,
  );
  assert.equal(emitted.length, 1);
  assert.equal(
    (await request(`${path}/${order.id}/refund`, owner, 'POST', { reason: 'Other reason' }, key))
      .body.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (
      await request(
        `${path}/${order.id}/refund`,
        owner,
        'POST',
        { reason: 'Event cancelled' },
        randomUUID(),
      )
    ).body.id,
    results[0].body.id,
  );
  const list = await request(path, owner);
  assert.equal(list.body.orders[0].refund.id, results[0].body.id);
  assert.equal(list.body.orders[0].canRequestRefund, false);
  assert.equal('buyerSubject' in list.body.orders[0], false);
  assert.equal(list.body.pageSize, 20);
  const lastPage = await request(`${path}?page=10000`, owner);
  assert.equal(lastPage.body.page, 10_000);
  assert.deepEqual(lastPage.body.orders, []);
  assert.equal((await request(`${path}?page=10001`, owner)).status, 422);
  assert.equal(
    (await request(`/api/v1/orders/${order.id}`, buyer)).body.refund.id,
    results[0].body.id,
  );
  allowed = false;
  try {
    assert.equal(
      (
        await request(
          `${path}/${order.id}/refund`,
          owner,
          'POST',
          { reason: 'Event cancelled' },
          key,
        )
      ).status,
      403,
    );
  } finally {
    allowed = true;
  }
});

test('refunds reject unverified users, staff, foreign events, missing keys and forged amounts', async () => {
  const { order, path } = await confirmed();
  const owner = await identity.token('owner');
  for (const token of [
    buyer,
    await identity.token('staff'),
    await identity.token('owner', { email_verified: false }),
  ])
    assert.equal(
      (
        await request(
          `${path}/${order.id}/refund`,
          token,
          'POST',
          { reason: 'Refund' },
          randomUUID(),
        )
      ).status,
      403,
    );
  assert.equal((await request(path)).status, 401);
  assert.equal(
    (
      await request(
        `${path}/${randomUUID()}/refund`,
        owner,
        'POST',
        { reason: 'Refund' },
        randomUUID(),
      )
    ).status,
    404,
  );
  assert.equal(
    (await request(`${path}/${order.id}/refund`, owner, 'POST', { reason: 'Refund' })).status,
    422,
  );
  assert.equal(
    (
      await request(
        `${path}/${order.id}/refund`,
        owner,
        'POST',
        { reason: 'Refund', amountMinor: 1 },
        randomUUID(),
      )
    ).status,
    422,
  );
  assert.equal(await fixture.db.orderRefund.count({ where: { orderId: order.id } }), 0);
});

test('refund deadline and confirmed payment binding are checked before issuing a fence', async () => {
  const owner = await identity.token('owner');
  const expired = await confirmed();
  await fixture.db.sale.update({
    where: { id: expired.sale.id },
    data: {
      startsAt: new Date(Date.now() - 1),
      salesEndsAt: new Date(Date.now() - 2),
      admissionStartsAt: new Date(Date.now() - 3),
    },
  });
  assert.equal(
    (
      await request(
        `${expired.path}/${expired.order.id}/refund`,
        owner,
        'POST',
        { reason: 'Refund' },
        randomUUID(),
      )
    ).body.code,
    'REFUND_WINDOW_CLOSED',
  );
  const missing = await confirmed();
  await fixture.db.paymentAuthorization.delete({ where: { orderId: missing.order.id } });
  assert.equal(
    (
      await request(
        `${missing.path}/${missing.order.id}/refund`,
        owner,
        'POST',
        { reason: 'Refund' },
        randomUUID(),
      )
    ).body.code,
    'PAYMENT_NOT_READY',
  );
  assert.equal(
    await fixture.db.orderRefund.count({
      where: { orderId: { in: [expired.order.id, missing.order.id] } },
    }),
    0,
  );
});

test('pre-refund reservation snapshots replay unchanged while current order reads include refund status', async () => {
  const sale = await seedSale(fixture.db),
    key = randomUUID();
  const input = { saleId: sale.id, seatIds: ['r1-s1'] };
  const first = await request('/api/v1/orders', buyer, 'POST', input, key);
  assert.equal(first.status, 201);
  const legacy = { ...first.body };
  delete legacy.refund;
  await fixture.db.reservationRequest.update({
    where: { buyerSubject_key: { buyerSubject: 'buyer', key } },
    data: { response: legacy },
  });
  const replay = await request('/api/v1/orders', buyer, 'POST', input, key);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, legacy);
  assert.equal((await request(`/api/v1/orders/${first.body.id}`, buyer)).body.refund, null);
});
