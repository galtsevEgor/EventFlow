import { expect, test } from 'vitest';
import {
  confirmedRefundCommandSchema,
  organizerRefundInput,
  refundRoutes,
  ticketRefundLockSchema,
} from '../src/index';

const lock = {
  operationId: '00000000-0000-4000-8000-000000000001',
  orderId: '00000000-0000-4000-8000-000000000002',
  saleId: '00000000-0000-4000-8000-000000000003',
  organizationId: '00000000-0000-4000-8000-000000000004',
  seatIds: ['r1-s1', 'r1-s2'],
  deadline: '2035-06-01T16:00:00Z',
};
test('refund fencing binds an entire unique seat set and excludes credentials', () => {
  expect(ticketRefundLockSchema.parse(lock)).toEqual(lock);
  expect(ticketRefundLockSchema.safeParse({ ...lock, seatIds: ['r1-s1', 'r1-s1'] }).success).toBe(
    false,
  );
  expect(ticketRefundLockSchema.safeParse({ ...lock, credential: 'private-code' }).success).toBe(
    false,
  );
});
test('confirmed refund commands have a fixed full amount and an explicit organizer reason', () => {
  const command = {
    operationId: lock.operationId,
    orderId: lock.orderId,
    attemptId: lock.saleId,
    providerPaymentId: 'fake-payment',
    buyerSubject: 'buyer',
    amountMinor: 5000,
    currency: 'EUR',
    provider: 'fake',
    reason: 'ORGANIZER_REQUESTED',
  };
  expect(confirmedRefundCommandSchema.parse(command)).toEqual(command);
  expect(confirmedRefundCommandSchema.safeParse({ ...command, amountMinor: 0 }).success).toBe(
    false,
  );
  expect(organizerRefundInput.parse({ reason: '  По запросу покупателя  ' }).reason).toBe(
    'По запросу покупателя',
  );
});
test('refund protocol has dedicated queues for each service', () => {
  expect(refundRoutes['payment-refunds']).toEqual(['ConfirmedOrderRefundRequested.v1']);
  expect(refundRoutes['ticket-refunds']).toContain('OrderRefunded.v1');
});
