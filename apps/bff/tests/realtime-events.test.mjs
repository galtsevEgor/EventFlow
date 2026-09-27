import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { realtimeHints } from '../dist/realtime/events.js';
import { message, realtimeInvalidation } from '@eventflow/event-contracts';

test('realtime relay strips domain payloads into scoped invalidations', () => {
  const id = randomUUID(),
    saleId = randomUUID(),
    organizationId = randomUUID();
  const event = message('booking', 'OrderStatisticsChanged.v1', id, 1, {
    orderId: id,
    saleId,
    organizationId,
    state: 'HELD',
    seatCount: 1,
    totalMinor: 2500,
    currency: 'EUR',
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    confirmedAt: null,
  });
  assert.deepEqual(realtimeHints(event), [
    { scope: 'sale', id: saleId },
    { scope: 'order', id },
  ]);
  assert.equal(
    realtimeHints({
      ...event,
      aggregateVersion: 2,
      data: { ...event.data, state: 'CONFIRMED', confirmedAt: new Date().toISOString() },
    }).length,
    3,
  );
  const payment = message('payments', 'PaymentSucceeded.v1', id, 1, {
    orderId: id,
    attemptId: randomUUID(),
    providerPaymentId: 'private-provider',
    buyerSubject: 'private-user',
    amountMinor: 2500,
    currency: 'EUR',
    verifiedAt: new Date().toISOString(),
    provider: 'fake',
  });
  assert.deepEqual(realtimeHints(payment), [{ scope: 'order', id }]);
});
test('relay rejects forged producers, extra fields and scope mismatches', () => {
  const event = realtimeInvalidation('booking', { scope: 'sale', id: randomUUID() });
  for (const forged of [
    { ...event, producer: 'payments' },
    { ...event, aggregateId: randomUUID() },
    { ...event, data: { ...event.data, email: 'private@example.test' } },
    { ...event, eventType: 'Unknown.v1' },
  ])
    assert.throws(() => realtimeHints(forged), /Invalid realtime/);
});
