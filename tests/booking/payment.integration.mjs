import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { bookingFixture } from '../helpers/booking.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { testIdentity, jsonRequest } from '../helpers/identity.mjs';
import { ageOrder } from '../helpers/order.mjs';
import { OrderSweeper } from '../../services/booking/dist/orders/sweeper.js';
import { ConfirmPayment } from '../../services/booking/dist/payments/confirm.js';
import { PaymentAuthorization } from '../../services/booking/dist/payments/authorization.js';
import {
  message,
  orderConfirmedSchema,
  refundRequestedSchema,
} from '../../packages/event-contracts/dist/index.js';

const namespace = `eventflow-test-${randomUUID()}`;
let fixture, identity, buyer, confirmer, authorization;
before(async () => {
  identity = await testIdentity();
  fixture = await bookingFixture(namespace, 0, { OIDC_ISSUER: identity.issuer });
  buyer = await identity.token();
  confirmer = fixture.app.get(ConfirmPayment);
  authorization = fixture.app.get(PaymentAuthorization);
  await fixture.app.get(OrderSweeper).stop();
});
after(async () => {
  await fixture?.close();
  await identity?.close();
  await cleanBroker(namespace);
});
const request = (...args) => jsonRequest(fixture.origin, ...args);
async function held() {
  const sale = await seedSale(fixture.db);
  const { body: order } = await request(
    '/api/v1/orders',
    buyer,
    'POST',
    { saleId: sale.id, seatIds: ['r1-s1', 'r1-s2'] },
    randomUUID(),
  );
  const attemptId = randomUUID();
  await authorization.authorize(order.id, attemptId, 'buyer', 'fake');
  const result = {
    orderId: order.id,
    attemptId,
    providerPaymentId: `fake_${randomUUID()}`,
    buyerSubject: 'buyer',
    amountMinor: order.totalMinor,
    currency: 'EUR',
    provider: 'fake',
    verifiedAt: new Date().toISOString(),
  };
  return { sale, order, result };
}
const success = (result) => message('payments', 'PaymentSucceeded.v1', result.orderId, 1, result);
async function events(id, type) {
  return (await fixture.db.outbox.findMany()).filter(
    (e) => e.envelope.aggregateId === id && e.envelope.eventType === type,
  );
}

test('only scoped Payments identity authorizes the owned payable snapshot', async () => {
  const { order } = await held();
  const path = `/internal/orders/${order.id}/payment-state`;
  assert.equal((await request(path, buyer)).status, 403);
  const policy = await identity.token('service-policy', {
    azp: 'eventflow-policy',
    realm_access: { roles: ['policy-check'] },
  });
  assert.equal((await request(path, policy)).status, 403);
  const service = await identity.token('service-payments', {
    azp: 'eventflow-payments',
    realm_access: { roles: ['booking-payments'] },
  });
  assert.equal((await request(path, service)).body.amountMinor, order.totalMinor);
  assert.equal(
    (
      await request(
        `/internal/buyer/orders/${order.id}/payment-state`,
        await identity.token('other'),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/internal/orders/${order.id}/payment-authorization`, service, 'POST', {
        attemptId: randomUUID(),
        buyerSubject: 'buyer',
        provider: 'fake',
      })
    ).status,
    409,
  );
});

test('concurrent duplicate successes sell every seat once and emit one OrderConfirmed', async () => {
  const { order, result } = await held();
  await Promise.all(Array.from({ length: 12 }, () => confirmer.handle(success(result))));
  const saved = await fixture.db.order.findUnique({ where: { id: order.id } });
  assert.equal(saved.state, 'CONFIRMED');
  assert.equal(saved.confirmedPaymentId, result.providerPaymentId);
  assert.equal(
    await fixture.db.seatInventory.count({
      where: { currentOrderId: order.id, state: 'SOLD', expiresAt: null },
    }),
    2,
  );
  const emitted = await events(order.id, 'OrderConfirmed.v1');
  assert.equal(emitted.length, 1);
  assert.equal(orderConfirmedSchema.parse(emitted[0].envelope.data).items.length, 2);
  assert.equal((await request(`/api/v1/orders/${order.id}/cancel`, buyer, 'POST')).status, 409);
  assert.equal(
    (
      await fixture.db.buyerSaleSlot.findUnique({
        where: { buyerSubject_saleId: { buyerSubject: 'buyer', saleId: order.saleId } },
      })
    ).currentOrderId,
    null,
  );
});

test('late success refunds once and cannot touch seats reassigned to another buyer', async () => {
  const { sale, order, result } = await held();
  await ageOrder(fixture.db, order.id);
  const newer = await request(
    '/api/v1/orders',
    await identity.token('new-buyer'),
    'POST',
    {
      saleId: sale.id,
      seatIds: ['r1-s1', 'r1-s2'],
    },
    randomUUID(),
  );
  assert.equal(newer.status, 201);
  await Promise.all([confirmer.handle(success(result)), confirmer.handle(success(result))]);
  assert.equal((await fixture.db.order.findUnique({ where: { id: order.id } })).state, 'EXPIRED');
  assert.equal(
    await fixture.db.seatInventory.count({
      where: { currentOrderId: newer.body.id, state: 'HELD' },
    }),
    2,
  );
  assert.equal((await events(order.id, 'OrderConfirmed.v1')).length, 0);
  const refunds = await events(order.id, 'PaymentRefundRequested.v1');
  assert.equal(refunds.length, 1);
  assert.equal(refundRequestedSchema.parse(refunds[0].envelope.data).reason, 'HOLD_EXPIRED');
});

test('mismatched amount/currency/buyer/attempt are reviewed without selling seats', async () => {
  for (const change of [
    { amountMinor: 1 },
    { currency: 'USD' },
    { buyerSubject: 'other' },
    { attemptId: randomUUID() },
  ]) {
    const { order, result } = await held();
    await confirmer.handle(success({ ...result, ...change }));
    assert.equal((await fixture.db.order.findUnique({ where: { id: order.id } })).state, 'HELD');
    assert.equal((await events(order.id, 'OrderConfirmed.v1')).length, 0);
    assert.equal((await events(order.id, 'PaymentReviewRequired.v1')).length, 1);
    assert.equal(
      (
        await fixture.db.paymentResult.findUnique({
          where: { providerPaymentId: result.providerPaymentId },
        })
      ).disposition,
      'REVIEW',
    );
  }
});

test('a second payment is compensated while confirmed seats remain sold', async () => {
  const { order, result } = await held();
  await confirmer.handle(success(result));
  await confirmer.handle(success({ ...result, providerPaymentId: `extra_${randomUUID()}` }));
  assert.equal(
    (await fixture.db.order.findUnique({ where: { id: order.id } })).confirmedPaymentId,
    result.providerPaymentId,
  );
  assert.equal(
    await fixture.db.seatInventory.count({ where: { currentOrderId: order.id, state: 'SOLD' } }),
    2,
  );
  assert.equal(
    (await events(order.id, 'PaymentRefundRequested.v1'))[0].envelope.data.reason,
    'EXTRA_PAYMENT',
  );
});

test('confirmation waiting on a seat lock uses the database clock after expiry', async () => {
  const { order, result } = await held();
  await ageOrder(fixture.db, order.id, new Date(Date.now() + 700));
  let locked;
  const ready = new Promise((resolve) => {
    locked = resolve;
  });
  const blocking = fixture.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "seatId" FROM "SeatInventory" WHERE "currentOrderId" = ${order.id}::uuid ORDER BY "seatId" FOR UPDATE`;
    locked();
    await tx.$queryRaw`SELECT 1 FROM pg_sleep(GREATEST(0, (SELECT EXTRACT(EPOCH FROM ("expiresAt" - clock_timestamp())) FROM "Order" WHERE id = ${order.id}::uuid)) + 0.05)`;
  });
  await ready;
  await confirmer.handle(success(result));
  await blocking;
  assert.equal((await fixture.db.order.findUnique({ where: { id: order.id } })).state, 'EXPIRED');
  assert.equal((await events(order.id, 'PaymentRefundRequested.v1')).length, 1);
});
