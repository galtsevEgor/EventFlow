import assert from 'node:assert/strict';
import test from 'node:test';
import { paymentPolling } from '../app/booking/payment-polling.ts';

test('an open SSE connection cannot delay recovery of an unresolved payment snapshot', () => {
  const created = { state: 'CREATED', bookingState: 'PENDING', refundState: null, canPay: false };
  assert.equal(paymentPolling(created, 'HELD', true), 3000);
  assert.equal(paymentPolling(null, 'HELD', true), 3000);
  assert.equal(paymentPolling({ ...created, state: 'NEEDS_RECONCILIATION' }, 'HELD', true), 3000);
  assert.equal(
    paymentPolling({ ...created, state: 'REQUIRES_ACTION', canPay: true }, 'HELD', true),
    30000,
  );
  assert.equal(
    paymentPolling(
      { ...created, state: 'SUCCEEDED', bookingState: 'CONFIRMED' },
      'CONFIRMED',
      true,
    ),
    30000,
  );
  assert.equal(paymentPolling(null, 'EXPIRED', true), false);
  assert.equal(paymentPolling(created, 'HELD', true, true), 3000);
});
