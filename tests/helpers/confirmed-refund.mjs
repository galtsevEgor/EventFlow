import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jsonRequest } from './identity.mjs';
import { seedSale } from './sale.mjs';
import { eventually } from './eventually.mjs';

export async function confirmedOrder(fixture) {
  const buyer = await fixture.identity.token('buyer', {
    aud: ['eventflow-booking', 'eventflow-payments', 'eventflow-tickets'],
  });
  const sale = await seedSale(fixture.booking.db, {
    admissionStartsAt: new Date(Date.now() - 60000),
  });
  const { body: order, status } = await jsonRequest(
    fixture.booking.origin,
    '/api/v1/orders',
    buyer,
    'POST',
    { saleId: sale.id, seatIds: ['r1-s1', 'r1-s2'] },
    randomUUID(),
  );
  assert.equal(status, 201);
  const created = await jsonRequest(
    fixture.origin,
    `/api/v1/orders/${order.id}/payment-attempt`,
    buyer,
    'POST',
    {},
    randomUUID(),
  );
  assert.equal(created.status, 202);
  const id = created.body.attemptId;
  await eventually(() => fixture.processor.run(id), Boolean);
  const attempt = await fixture.db.paymentAttempt.findUniqueOrThrow({ where: { id } });
  await fixture.provider.confirm(attempt.providerPaymentId, 'success');
  await fixture.processor.wake(id);
  await eventually(() => fixture.processor.run(id), Boolean);
  await eventually(
    () => fixture.booking.db.order.findUnique({ where: { id: order.id } }),
    (row) => row.state === 'CONFIRMED',
  );
  const path = `/api/v1/organizations/${sale.organizationId}/events/${sale.id}/orders/${order.id}/refund`;
  const owner = await fixture.identity.token('owner');
  return {
    sale,
    order,
    attempt,
    buyer,
    request: (key = randomUUID()) =>
      jsonRequest(fixture.booking.origin, path, owner, 'POST', { reason: 'Event cancelled' }, key),
  };
}
