import {
  availabilitySchema,
  orderStatisticsSchema,
  orderRefundedSchema,
  paymentSucceededSchema,
  refundOutcomeSchema,
  realtimeHintSchema,
  waitlistChangedSchema,
  type EventEnvelope,
  type RealtimeHint,
} from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';

export function realtimeHints(event: EventEnvelope): RealtimeHint[] {
  const invalid = () => new PermanentMessageError('Invalid realtime event');
  if (event.eventType === 'WaitlistChanged.v1') {
    const d = waitlistChangedSchema.safeParse(event.data);
    if (!d.success || event.producer !== 'waitlist' || d.data.entryId !== event.aggregateId)
      throw invalid();
    return [
      { scope: 'waitlist', id: d.data.entryId },
      { scope: 'organizer-orders', id: d.data.saleId, organizationId: d.data.organizationId },
    ];
  }
  if (event.eventType === 'RealtimeInvalidated.v1') {
    const result = realtimeHintSchema.safeParse(event.data);
    if (
      !result.success ||
      result.data.id !== event.aggregateId ||
      event.producer === 'catalog' ||
      (result.data.scope !== 'order' && event.producer !== 'booking')
    )
      throw invalid();
    return [result.data];
  }
  if (event.eventType === 'OrderStatisticsChanged.v1' || event.eventType === 'OrderRefunded.v1') {
    const result =
      event.eventType === 'OrderRefunded.v1'
        ? orderRefundedSchema.safeParse(event.data)
        : orderStatisticsSchema.safeParse(event.data);
    if (
      !result.success ||
      event.producer !== 'booking' ||
      result.data.orderId !== event.aggregateId
    )
      throw invalid();
    const data = result.data;
    return [
      { scope: 'sale', id: data.saleId },
      { scope: 'order', id: data.orderId },
      ...(['CONFIRMED', 'REFUNDED'].includes(data.state)
        ? [
            {
              scope: 'organizer-orders' as const,
              id: data.saleId,
              organizationId: data.organizationId,
            },
          ]
        : []),
    ];
  }
  if (event.eventType === 'SaleAvailabilityChanged.v1') {
    if (event.producer !== 'booking' || !availabilitySchema.safeParse(event.data).success)
      throw invalid();
    return [{ scope: 'sale', id: event.aggregateId }];
  }
  if (event.producer !== 'payments') throw invalid();
  if (event.eventType === 'PaymentSucceeded.v1') {
    const data = paymentSucceededSchema.safeParse(event.data);
    if (!data.success || data.data.orderId !== event.aggregateId) throw invalid();
  } else {
    const result = refundOutcomeSchema.safeParse(event.data);
    const success = ['RefundSucceeded.v1', 'ConfirmedOrderRefundSucceeded.v1'].includes(
      event.eventType,
    );
    if (
      ![
        'RefundSucceeded.v1',
        'RefundFailed.v1',
        'RefundReviewRequired.v1',
        'ConfirmedOrderRefundSucceeded.v1',
        'ConfirmedOrderRefundReviewRequired.v1',
      ].includes(event.eventType) ||
      !result.success ||
      result.data.orderId !== event.aggregateId ||
      success !== (result.data.state === 'SUCCEEDED')
    )
      throw invalid();
  }
  return [{ scope: 'order', id: event.aggregateId }];
}

export const realtimeTopic = (hint: RealtimeHint) =>
  `${hint.scope}:${hint.id}:${'organizationId' in hint ? hint.organizationId : ''}`;
