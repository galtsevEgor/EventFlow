import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jsonRequest } from './identity.mjs';
import { seedSale } from './sale.mjs';
import { ageOrder } from './order.mjs';
import { eventually } from './eventually.mjs';

export async function pendingRefund(fixture) {
  const buyer = await fixture.identity.token('buyer', {
    aud: ['eventflow-booking', 'eventflow-payments'],
  });
  const sale = await seedSale(fixture.booking.db);
  const held = await jsonRequest(
    fixture.booking.origin,
    '/api/v1/orders',
    buyer,
    'POST',
    {
      saleId: sale.id,
      seatIds: ['r1-s1'],
    },
    randomUUID(),
  );
  assert.equal(held.status, 201);
  const created = await jsonRequest(
    fixture.origin,
    `/api/v1/orders/${held.body.id}/payment-attempt`,
    buyer,
    'POST',
    {},
    randomUUID(),
  );
  assert.equal(created.status, 202);
  const id = created.body.attemptId;
  await eventually(() => fixture.processor.run(id), Boolean);
  const attempt = await fixture.db.paymentAttempt.findUnique({ where: { id } });
  assert.ok(attempt.providerPaymentId);
  await fixture.provider.confirm(attempt.providerPaymentId, 'success');
  await ageOrder(fixture.booking.db, held.body.id);
  await fixture.processor.wake(id);
  await eventually(() => fixture.processor.run(id), Boolean);
  const refund = await eventually(
    () => fixture.db.refundOperation.findUnique({ where: { attemptId: id } }),
    Boolean,
  );
  return { order: held.body, attempt, refund, buyer };
}
