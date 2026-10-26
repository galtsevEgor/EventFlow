import { z } from 'zod';
import type { EventEnvelope } from './index.js';
import { message } from './sales.js';

export const realtimeHintSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('order'), id: z.uuid() }),
  z.strictObject({ scope: z.literal('sale'), id: z.uuid() }),
  z.strictObject({ scope: z.literal('waitlist'), id: z.uuid() }),
  z.strictObject({ scope: z.literal('organizer-orders'), id: z.uuid(), organizationId: z.uuid() }),
]);
export type RealtimeHint = z.infer<typeof realtimeHintSchema>;

export function realtimeInvalidation(
  producer: Exclude<EventEnvelope['producer'], 'catalog'>,
  hint: RealtimeHint,
) {
  const data = realtimeHintSchema.parse(hint);
  if (producer !== 'booking' && data.scope !== 'order') throw new Error('Invalid realtime scope');
  return message(producer, 'RealtimeInvalidated.v1', data.id, 1, data);
}

export const realtimeEventTypes = [
  'WaitlistChanged.v1',
  'RealtimeInvalidated.v1',
  'OrderStatisticsChanged.v1',
  'OrderRefunded.v1',
  'SaleAvailabilityChanged.v1',
  'PaymentSucceeded.v1',
  'RefundSucceeded.v1',
  'RefundFailed.v1',
  'RefundReviewRequired.v1',
  'ConfirmedOrderRefundSucceeded.v1',
  'ConfirmedOrderRefundReviewRequired.v1',
];
