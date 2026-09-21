import { expect, test } from 'vitest';
import { commerceRoutes, orderStatisticsSchema } from '../src/index';

const held = {
  orderId: '00000000-0000-4000-8000-000000000001',
  saleId: '00000000-0000-4000-8000-000000000002',
  organizationId: '00000000-0000-4000-8000-000000000003',
  state: 'HELD',
  seatCount: 2,
  totalMinor: 5000,
  currency: 'EUR',
  createdAt: '2026-11-05T10:00:00Z',
  expiresAt: '2026-11-05T10:10:00Z',
  confirmedAt: null,
};
test('statistics snapshots exclude personal fields and require a matching confirmation time', () => {
  expect(orderStatisticsSchema.parse(held)).toEqual(held);
  expect(orderStatisticsSchema.safeParse({ ...held, buyerSubject: 'private' }).success).toBe(false);
  expect(orderStatisticsSchema.safeParse({ ...held, state: 'CONFIRMED' }).success).toBe(false);
  expect(orderStatisticsSchema.safeParse({ ...held, seatCount: 0 }).success).toBe(false);
  expect(
    orderStatisticsSchema.safeParse({ ...held, state: 'CONFIRMED', confirmedAt: held.createdAt })
      .success,
  ).toBe(true);
  expect(commerceRoutes.statistics).toContain('RefundSucceeded.v1');
  expect(commerceRoutes.statistics).not.toContain('RefundReviewRequired.v1');
});
