import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { paymentsFixture } from '../helpers/payments.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { jsonRequest } from '../helpers/identity.mjs';
import { realtimeHintSchema } from '../../packages/event-contracts/dist/index.js';

test('payment state changes notify the owned order without creating a polling feedback loop', async () => {
  const fixture = await paymentsFixture();
  try {
    const token = await fixture.identity.token('buyer', {
      aud: ['eventflow-booking', 'eventflow-payments'],
    });
    const sale = await seedSale(fixture.booking.db);
    const reserved = await jsonRequest(
      fixture.booking.origin,
      '/api/v1/orders',
      token,
      'POST',
      { saleId: sale.id, seatIds: ['r1-s1'] },
      randomUUID(),
    );
    assert.equal(reserved.status, 201);
    const orderId = reserved.body.id;
    const created = await jsonRequest(
      fixture.origin,
      `/api/v1/orders/${orderId}/payment-attempt`,
      token,
      'POST',
      {},
      randomUUID(),
    );
    assert.equal(created.status, 202);
    const id = created.body.attemptId;
    await fixture.processor.run(id);
    const hints = async () =>
      (await fixture.db.outbox.findMany()).filter(
        (row) =>
          row.envelope.eventType === 'RealtimeInvalidated.v1' &&
          row.envelope.aggregateId === orderId,
      );
    const initial = await hints();
    assert.equal(initial.length, 2);
    await fixture.processor.wake(id);
    await fixture.processor.run(id);
    assert.equal((await hints()).length, 2);
    fixture.provider.inject('retrieve', { failBefore: true });
    await fixture.processor.wake(id);
    await fixture.processor.run(id);
    assert.equal(
      (await fixture.db.paymentAttempt.findUnique({ where: { id } })).state,
      'NEEDS_RECONCILIATION',
    );
    assert.equal((await hints()).length, 3);
    await fixture.processor.wake(id);
    await fixture.processor.run(id);
    assert.equal((await hints()).length, 4);
    for (const row of await hints())
      assert.deepEqual(realtimeHintSchema.parse(row.envelope.data), {
        scope: 'order',
        id: orderId,
      });
  } finally {
    await fixture.close();
  }
});
