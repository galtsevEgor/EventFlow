import { z } from 'zod';

export const orderStatisticsSchema = z
  .strictObject({
    orderId: z.uuid(),
    saleId: z.uuid(),
    organizationId: z.uuid(),
    state: z.enum(['HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED']),
    seatCount: z.number().int().min(1).max(6),
    totalMinor: z.number().int().positive().max(600_000_000),
    currency: z.literal('EUR'),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    confirmedAt: z.iso.datetime().nullable(),
  })
  .refine((value) => (value.state === 'CONFIRMED') === (value.confirmedAt !== null), {
    message: 'Only a confirmed order has a confirmation time',
  });

export const statisticsEventTypes = [
  'OrderStatisticsChanged.v1',
  'PaymentSucceeded.v1',
  'RefundSucceeded.v1',
  'PaymentStatisticsReplayed.v1',
  'RefundStatisticsReplayed.v1',
] as const;
