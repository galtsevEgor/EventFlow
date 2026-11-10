import { z } from 'zod';
import { eventCurrencySchema, MAX_ORDER_TOTAL_MINOR, MAX_SEATS_PER_ORDER } from './purchase.js';

export const orderStatisticsSchema = z
  .strictObject({
    orderId: z.uuid(),
    saleId: z.uuid(),
    organizationId: z.uuid(),
    analyticsSessionId: z.uuid().nullable().optional(),
    state: z.enum(['HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED']),
    seatCount: z.number().int().min(1).max(MAX_SEATS_PER_ORDER),
    totalMinor: z.number().int().positive().max(MAX_ORDER_TOTAL_MINOR),
    currency: eventCurrencySchema,
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
