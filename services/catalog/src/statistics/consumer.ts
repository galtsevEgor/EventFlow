import { createHash } from 'node:crypto';
import {
  orderStatisticsSchema,
  paymentSucceededSchema,
  refundOutcomeSchema,
  type EventEnvelope,
} from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import { Database } from '../database';
import { Prisma } from '../generated/client';

const invalid = () => new PermanentMessageError('Conflicting statistics fact');
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export class StatisticsConsumer {
  constructor(private readonly db: Database) {}

  async handle(event: EventEnvelope) {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`statistics:${event.aggregateId.toLowerCase()}`}, 0))`;
        if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
        if (event.eventType === 'OrderStatisticsChanged.v1') await this.order(tx, event);
        else if (['PaymentSucceeded.v1', 'PaymentStatisticsReplayed.v1'].includes(event.eventType))
          await this.payment(tx, event);
        else if (['RefundSucceeded.v1', 'RefundStatisticsReplayed.v1'].includes(event.eventType))
          await this.refund(tx, event);
        else throw invalid();
        await tx.inbox.create({ data: { eventId: event.eventId } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw invalid();
      throw error;
    }
  }

  private async order(tx: Prisma.TransactionClient, event: EventEnvelope) {
    const parsed = orderStatisticsSchema.safeParse(event.data);
    if (!parsed.success || event.producer !== 'booking') throw invalid();
    const data = parsed.data;
    if (
      event.aggregateId !== data.orderId ||
      event.aggregateVersion !== (data.state === 'HELD' ? 1 : 2)
    )
      throw invalid();
    const draft = await tx.eventDraft.findFirst({
      where: { id: data.saleId, organizationId: data.organizationId },
      select: { id: true },
    });
    if (!draft) throw invalid();
    const previous = await tx.salesOrder.findUnique({ where: { orderId: data.orderId } });
    const payloadHash = hash(data);
    if (previous) {
      if (previous.version > event.aggregateVersion) return;
      if (previous.version === event.aggregateVersion) {
        if (previous.payloadHash !== payloadHash) throw invalid();
        return;
      }
      if (
        previous.eventId !== data.saleId ||
        previous.organizationId !== data.organizationId ||
        previous.seatCount !== data.seatCount ||
        previous.totalMinor !== data.totalMinor ||
        previous.currency !== data.currency ||
        +previous.createdAt !== +new Date(data.createdAt) ||
        +previous.expiresAt !== +new Date(data.expiresAt)
      )
        throw invalid();
    }
    const { saleId, ...values } = data;
    const record = {
      ...values,
      eventId: saleId,
      version: event.aggregateVersion,
      payloadHash,
      updatedAt: new Date(),
    };
    await tx.salesOrder.upsert({
      where: { orderId: data.orderId },
      create: record,
      update: record,
    });
  }

  private async payment(tx: Prisma.TransactionClient, event: EventEnvelope) {
    const parsed = paymentSucceededSchema.safeParse(event.data);
    if (
      !parsed.success ||
      event.producer !== 'payments' ||
      event.aggregateId !== parsed.data.orderId
    )
      throw invalid();
    const { attemptId, orderId, providerPaymentId, amountMinor, currency, verifiedAt } =
      parsed.data;
    const data = { attemptId, orderId, providerPaymentId, amountMinor, currency, verifiedAt };
    const payloadHash = hash(data);
    const previous = await tx.salesPayment.findUnique({ where: { attemptId } });
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw invalid();
      return;
    }
    await tx.salesPayment.create({ data: { ...data, payloadHash } });
  }

  private async refund(tx: Prisma.TransactionClient, event: EventEnvelope) {
    const parsed = refundOutcomeSchema.safeParse(event.data);
    if (
      !parsed.success ||
      event.producer !== 'payments' ||
      parsed.data.state !== 'SUCCEEDED' ||
      event.aggregateId !== parsed.data.orderId
    )
      throw invalid();
    const { operationId, orderId, attemptId, providerPaymentId } = parsed.data;
    const data = { operationId, orderId, attemptId, providerPaymentId };
    const payloadHash = hash(data);
    const previous = await tx.salesRefund.findUnique({ where: { operationId } });
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw invalid();
      return;
    }
    await tx.salesRefund.create({ data: { ...data, payloadHash, completedAt: event.occurredAt } });
  }
}
