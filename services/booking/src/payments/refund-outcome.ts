import { refundOutcomeSchema, type EventEnvelope } from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import type { Database } from '../database';

export class RefundOutcome {
  constructor(private readonly db: Database) {}
  async handle(event: EventEnvelope) {
    const parsed = refundOutcomeSchema.safeParse(event.data);
    if (
      event.producer !== 'payments' ||
      !['RefundSucceeded.v1', 'RefundFailed.v1', 'RefundReviewRequired.v1'].includes(
        event.eventType,
      ) ||
      !parsed.success ||
      parsed.data.orderId !== event.aggregateId ||
      (event.eventType === 'RefundSucceeded.v1') !== (parsed.data.state === 'SUCCEEDED')
    )
      throw new PermanentMessageError('Invalid refund outcome');
    const value = parsed.data;
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${value.providerPaymentId}, 1))`;
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      const result = await tx.paymentResult.findUnique({
        where: { operationId: value.operationId },
      });
      if (
        !result ||
        result.orderId !== value.orderId ||
        result.attemptId !== value.attemptId ||
        result.providerPaymentId !== value.providerPaymentId
      )
        throw new PermanentMessageError('Unknown compensation');
      if (result.refundState !== 'SUCCEEDED')
        await tx.paymentResult.update({
          where: { providerPaymentId: value.providerPaymentId },
          data: { refundState: value.state },
        });
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }
}
