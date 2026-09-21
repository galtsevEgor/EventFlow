import {
  orderClosedSchema,
  orderConfirmedSchema,
  paymentReviewSchema,
  refundRequestedSchema,
  confirmedRefundCommandSchema,
  type EventEnvelope,
} from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import type { Database } from './database';

export class PaymentInbox {
  constructor(private readonly db: Database) {}
  async handle(event: EventEnvelope) {
    if (event.producer !== 'booking')
      throw new PermanentMessageError('Invalid payment command producer');
    const schema =
      event.eventType === 'OrderExpired.v1' || event.eventType === 'OrderCancelled.v1'
        ? orderClosedSchema
        : event.eventType === 'OrderConfirmed.v1'
          ? orderConfirmedSchema
          : event.eventType === 'PaymentRefundRequested.v1'
            ? refundRequestedSchema
            : event.eventType === 'ConfirmedOrderRefundRequested.v1'
              ? confirmedRefundCommandSchema
              : event.eventType === 'PaymentReviewRequired.v1'
                ? paymentReviewSchema
                : null;
    const parsed = schema?.safeParse(event.data);
    if (!parsed?.success || parsed.data.orderId !== event.aggregateId)
      throw new PermanentMessageError('Invalid payment command');
    const orderId = parsed.data.orderId;
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orderId}, 1))`;
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      if (event.eventType === 'OrderExpired.v1' || event.eventType === 'OrderCancelled.v1') {
        await tx.closedOrder.upsert({ where: { orderId }, create: { orderId }, update: {} });
        await tx.paymentAttempt.updateMany({
          where: { orderId },
          data: { cancelRequested: true, nextRunAt: new Date(0) },
        });
      } else {
        const attempt = await tx.paymentAttempt.findUnique({ where: { orderId } });
        if (!attempt && event.eventType === 'ConfirmedOrderRefundRequested.v1')
          throw new PermanentMessageError('Unknown refund payment');
        if (attempt) {
          const data = parsed.data;
          const valid =
            'attemptId' in data &&
            data.attemptId === attempt.id &&
            'providerPaymentId' in data &&
            data.providerPaymentId === attempt.providerPaymentId;
          if (!valid || event.eventType === 'PaymentReviewRequired.v1') {
            if (event.eventType === 'ConfirmedOrderRefundRequested.v1')
              throw new PermanentMessageError('Refund binding mismatch');
            await tx.paymentAttempt.update({
              where: { id: attempt.id },
              data: {
                bookingState: 'REQUIRES_REVIEW',
                reviewCode: 'BOOKING_BINDING_REVIEW',
              },
            });
          } else if (event.eventType === 'OrderConfirmed.v1') {
            if (!attempt.successPublished) throw new PermanentMessageError('Payment not verified');
            await tx.paymentAttempt.updateMany({
              where: {
                id: attempt.id,
                bookingState: { notIn: ['REFUND_PENDING', 'REFUNDED', 'REQUIRES_REVIEW'] },
              },
              data: { bookingState: 'CONFIRMED' },
            });
          } else {
            const refund =
              event.eventType === 'ConfirmedOrderRefundRequested.v1'
                ? confirmedRefundCommandSchema.parse(data)
                : refundRequestedSchema.parse(data);
            if (
              !attempt.successPublished ||
              refund.amountMinor !== attempt.amountMinor ||
              refund.currency !== attempt.currency ||
              refund.buyerSubject !== attempt.buyerSubject ||
              refund.provider !== attempt.provider
            )
              throw new PermanentMessageError('Refund binding mismatch');
            const existing = await tx.refundOperation.findUnique({
              where: { attemptId: attempt.id },
            });
            if (
              existing &&
              (existing.id !== refund.operationId || existing.reason !== refund.reason)
            )
              throw new PermanentMessageError('Conflicting refund operation');
            if (!existing)
              await tx.refundOperation.create({
                data: {
                  id: refund.operationId,
                  attemptId: attempt.id,
                  orderId,
                  providerPaymentId: refund.providerPaymentId,
                  amountMinor: refund.amountMinor,
                  currency: refund.currency,
                  reason: refund.reason,
                },
              });
            if (attempt.bookingState !== 'REFUNDED')
              await tx.paymentAttempt.update({
                where: { id: attempt.id },
                data: { bookingState: 'REFUND_PENDING' },
              });
          }
        }
      }
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }
}
