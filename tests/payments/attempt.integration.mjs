import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { paymentsFixture } from '../helpers/payments.mjs';
import { jsonRequest } from '../helpers/identity.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { ageOrder } from '../helpers/order.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { ProcessAttempt } from '../../services/payments/dist/attempts/process.js';
import { BookingClient } from '../../services/payments/dist/booking-client.js';
import { FakePaymentProvider } from '../../services/payments/dist/providers/fake.js';
let fixture, buyer;
before(async () => {
  fixture = await paymentsFixture();
  buyer = await fixture.identity.token('buyer', {
    aud: ['eventflow-booking', 'eventflow-payments'],
  });
});
after(async () => {
  await fixture?.close();
});
const request = (...args) => jsonRequest(fixture.origin, ...args);
async function held() {
  const sale = await seedSale(fixture.booking.db);
  const response = await jsonRequest(
    fixture.booking.origin,
    '/api/v1/orders',
    buyer,
    'POST',
    { saleId: sale.id, seatIds: ['r1-s1'] },
    randomUUID(),
  );
  assert.equal(response.status, 201);
  return response.body;
}
async function create(order, key = randomUUID()) {
  const result = await request(
    `/api/v1/orders/${order.id}/payment-attempt`,
    buyer,
    'POST',
    {},
    key,
  );
  assert.equal(result.status, 202);
  return result.body;
}
async function run(id) {
  await fixture.processor.wake(id);
  // A broker consumer may briefly hold this row; the production loop retries skipped claims.
  await eventually(() => fixture.processor.run(id), Boolean);
}

test('repeated creation across keys gives one attempt and rejects changed order, price and owner', async () => {
  const order = await held(),
    key = randomUUID();
  const first = await create(order, key);
  assert.deepEqual(await create(order, key.toUpperCase()), first);
  const responses = await Promise.all(Array.from({ length: 15 }, () => create(order)));
  assert.ok(responses.every((p) => p.attemptId === first.attemptId));
  const another = await held();
  assert.equal(
    (await request(`/api/v1/orders/${another.id}/payment-attempt`, buyer, 'POST', {}, key)).status,
    409,
  );
  assert.equal(
    (
      await request(
        `/api/v1/orders/${order.id}/payment-attempt`,
        buyer,
        'POST',
        { amountMinor: 1 },
        randomUUID(),
      )
    ).status,
    422,
  );
  const outsider = await fixture.identity.token('other', { aud: 'eventflow-payments' });
  assert.equal((await request(`/api/v1/orders/${order.id}/payment-status`, outsider)).status, 404);
  assert.equal(
    (
      await request(
        `/api/v1/orders/${order.id}/payment-attempt`,
        outsider,
        'POST',
        {},
        randomUUID(),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/api/v1/orders/${order.id}/payment-attempt`,
        undefined,
        'POST',
        {},
        randomUUID(),
      )
    ).status,
    401,
  );
});

test('lost create response recovers with same provider key after replacing processor and provider', async () => {
  const order = await held(),
    created = await create(order);
  fixture.provider.inject('create', { loseResponse: true });
  await run(created.attemptId);
  assert.equal(
    (await fixture.db.paymentAttempt.findUnique({ where: { id: created.attemptId } })).state,
    'NEEDS_RECONCILIATION',
  );
  const restarted = new ProcessAttempt(
    fixture.db,
    fixture.app.get(BookingClient),
    new FakePaymentProvider(fixture.db),
  );
  await restarted.wake(created.attemptId);
  await restarted.run(created.attemptId);
  const status = await request(`/api/v1/orders/${order.id}/payment-status`, buyer);
  assert.equal(status.body.canPay, true);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal(await fixture.db.fakePayment.count({ where: { attemptId: created.attemptId } }), 1);
});

test('successful fake payment travels through real RabbitMQ to Booking and back', async () => {
  const order = await held(),
    created = await create(order);
  await run(created.attemptId);
  assert.equal(
    (
      await request(`/api/v1/orders/${order.id}/payment-attempt/fake-confirm`, buyer, 'POST', {
        outcome: 'success',
      })
    ).status,
    202,
  );
  await run(created.attemptId);
  const saved = await eventually(
    () => fixture.db.paymentAttempt.findUnique({ where: { id: created.attemptId } }),
    (p) => p.bookingState === 'CONFIRMED',
  );
  assert.equal(saved.state, 'SUCCEEDED');
  assert.equal(
    (await fixture.booking.db.order.findUnique({ where: { id: order.id } })).state,
    'CONFIRMED',
  );
  const status = (await request(`/api/v1/orders/${order.id}/payment-status`, buyer)).body;
  assert.equal(status.canPay, false);
  assert.equal(status.clientSecret, null);
  assert.equal(await fixture.processor.run(created.attemptId), false);
  assert.equal(
    (await fixture.db.outbox.findMany()).filter(
      (e) => e.envelope.aggregateId === order.id && e.envelope.eventType === 'PaymentSucceeded.v1',
    ).length,
    1,
  );
});

test('expiry during a slow create never exposes a payable form and cancels the provider intent', async () => {
  const order = await held(),
    created = await create(order);
  fixture.provider.inject('create', { delayMs: 250 });
  const pending = run(created.attemptId);
  await eventually(
    () => fixture.db.paymentAttempt.findUnique({ where: { id: created.attemptId } }),
    (p) => p.authorized,
  );
  await ageOrder(fixture.booking.db, order.id);
  await pending;
  const status = (await request(`/api/v1/orders/${order.id}/payment-status`, buyer)).body;
  assert.equal(status.canPay, false);
  assert.equal(status.state, 'CANCELLED');
  assert.equal(
    (await fixture.db.fakePayment.findUnique({ where: { attemptId: created.attemptId } })).status,
    'cancelled',
  );
});

test('processing survives cancellation and late success requests a single durable refund', async () => {
  const order = await held(),
    created = await create(order);
  await run(created.attemptId);
  const attempt = await fixture.db.paymentAttempt.findUnique({ where: { id: created.attemptId } });
  await fixture.provider.confirm(attempt.providerPaymentId, 'processing');
  await jsonRequest(fixture.booking.origin, `/api/v1/orders/${order.id}/cancel`, buyer, 'POST');
  await run(created.attemptId);
  assert.equal(
    (await fixture.db.paymentAttempt.findUnique({ where: { id: created.attemptId } })).state,
    'PROCESSING',
  );
  await fixture.provider.confirm(attempt.providerPaymentId, 'success');
  await run(created.attemptId);
  const refund = await eventually(
    () => fixture.db.refundOperation.findUnique({ where: { attemptId: created.attemptId } }),
    Boolean,
  );
  assert.equal(refund.state, 'PENDING');
  assert.equal(refund.amountMinor, order.totalMinor);
  assert.equal(
    (await fixture.booking.db.order.findUnique({ where: { id: order.id } })).state,
    'CANCELLED',
  );
});

test('a cancelled order before processing creates no provider payment even if its event arrives early', async () => {
  const order = await held(),
    created = await create(order);
  await jsonRequest(fixture.booking.origin, `/api/v1/orders/${order.id}/cancel`, buyer, 'POST');
  await eventually(
    () => fixture.db.closedOrder.findUnique({ where: { orderId: order.id } }),
    Boolean,
  );
  await run(created.attemptId);
  assert.equal(await fixture.db.fakePayment.count({ where: { attemptId: created.attemptId } }), 0);
  assert.equal(
    (await fixture.db.paymentAttempt.findUnique({ where: { id: created.attemptId } })).state,
    'CANCELLED',
  );
});
