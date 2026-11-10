import { createHash, randomUUID } from 'node:crypto';
import { message, paymentSucceededSchema, type EventEnvelope } from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import type { Database } from '../database';
import type { Order, OrderItem, SeatInventory } from '../generated/client';
import {
  decisionTime,
  lockOrder,
  lockSeats,
  lockSlot,
  transaction,
  type Transaction,
} from '../orders/transaction';
import { release } from '../orders/release';
import { recordOrderStatistics } from '../orders/statistics';

type Payment = Omit<ReturnType<typeof paymentSucceededSchema.parse>, 'verifiedAt'>;
type PaymentResult = Pick<Payment, 'providerPaymentId' | 'orderId' | 'attemptId'> & {
  payloadHash: string;
};

function refundReason(order: Order, seats: SeatInventory[], itemCount: number, now: Date) {
  if (order.state === 'CONFIRMED') return 'EXTRA_PAYMENT';
  if (order.state === 'CANCELLED') return 'ORDER_CANCELLED';
  if (order.state === 'EXPIRED' || now >= order.expiresAt) return 'HOLD_EXPIRED';
  const ownsSeats =
    seats.length === itemCount &&
    itemCount > 0 &&
    seats.every(
      (seat) =>
        seat.state === 'HELD' &&
        seat.currentOrderId === order.id &&
        seat.expiresAt !== null &&
        seat.expiresAt > now,
    );
  return ownsSeats ? null : 'SEATS_LOST';
}

async function enqueuePaymentOutcome(
  tx: Transaction,
  source: EventEnvelope,
  type: string,
  data: EventEnvelope['data'],
) {
  const reply = message('booking', type, source.aggregateId, 2, data, source);
  await tx.outbox.create({ data: { id: reply.eventId, envelope: reply } });
}

function review(tx: Transaction, source: EventEnvelope, payment: Payment, code: string) {
  return enqueuePaymentOutcome(tx, source, 'PaymentReviewRequired.v1', {
    orderId: payment.orderId,
    attemptId: payment.attemptId,
    providerPaymentId: payment.providerPaymentId,
    code,
  });
}

async function confirmOrder(
  tx: Transaction,
  source: EventEnvelope,
  payment: Payment,
  order: Order,
  items: OrderItem[],
  now: Date,
) {
  await tx.order.update({
    where: { id: order.id },
    data: {
      state: 'CONFIRMED',
      confirmedPaymentId: payment.providerPaymentId,
      confirmedAt: now,
    },
  });
  await tx.seatInventory.updateMany({
    where: { saleId: order.saleId, currentOrderId: order.id },
    data: { state: 'SOLD', expiresAt: null, version: { increment: 1 } },
  });
  await tx.buyerSaleSlot.updateMany({
    where: {
      buyerSubject: order.buyerSubject,
      saleId: order.saleId,
      currentOrderId: order.id,
    },
    data: { currentOrderId: null },
  });
  await enqueuePaymentOutcome(tx, source, 'OrderConfirmed.v1', {
    orderId: order.id,
    attemptId: payment.attemptId,
    providerPaymentId: payment.providerPaymentId,
    saleId: order.saleId,
    organizationId: order.organizationId,
    buyerSubject: order.buyerSubject,
    title: order.title,
    totalMinor: order.totalMinor,
    currency: order.currency,
    confirmedAt: now.toISOString(),
    items: items.map(({ seatId, row, number, categoryName, priceMinor }) => ({
      seatId,
      row,
      number,
      categoryName,
      priceMinor,
    })),
  });
  await recordOrderStatistics(tx, order.id);
}

export class ConfirmPayment {
  constructor(private readonly db: Database) {}

  async handle(event: EventEnvelope) {
    const parsed = paymentSucceededSchema.safeParse(event.data);
    if (
      event.producer !== 'payments' ||
      event.eventType !== 'PaymentSucceeded.v1' ||
      !parsed.success ||
      event.aggregateId !== parsed.data.orderId
    )
      throw new PermanentMessageError('Invalid payment result');

    // Keep the original serialization used by existing PaymentResult rows.
    const payment: Payment = {
      orderId: parsed.data.orderId,
      attemptId: parsed.data.attemptId,
      providerPaymentId: parsed.data.providerPaymentId,
      buyerSubject: parsed.data.buyerSubject,
      amountMinor: parsed.data.amountMinor,
      currency: parsed.data.currency,
      provider: parsed.data.provider,
    };
    const result = {
      providerPaymentId: payment.providerPaymentId,
      orderId: payment.orderId,
      attemptId: payment.attemptId,
      payloadHash: createHash('sha256').update(JSON.stringify(payment)).digest('hex'),
    };

    await transaction(this.db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${payment.providerPaymentId}, 1))`;
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      const previous = await tx.paymentResult.findUnique({
        where: { providerPaymentId: payment.providerPaymentId },
      });
      if (previous) {
        if (previous.payloadHash !== result.payloadHash)
          await review(tx, event, payment, 'PAYMENT_BINDING_CHANGED');
      } else {
        await this.applyPayment(tx, event, payment, result);
      }
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }

  private async applyPayment(
    tx: Transaction,
    event: EventEnvelope,
    payment: Payment,
    result: PaymentResult,
  ) {
    const found = await tx.order.findUnique({ where: { id: payment.orderId } });
    const authorization = await tx.paymentAuthorization.findUnique({
      where: { attemptId: payment.attemptId },
    });
    if (
      !found ||
      authorization?.orderId !== found.id ||
      authorization.provider !== payment.provider ||
      found.buyerSubject !== payment.buyerSubject ||
      found.totalMinor !== payment.amountMinor ||
      found.currency !== payment.currency
    ) {
      const reason = 'PAYMENT_BINDING_MISMATCH';
      await tx.paymentResult.create({ data: { ...result, disposition: 'REVIEW', reason } });
      await review(tx, event, payment, reason);
      return;
    }

    await lockSlot(tx, found.buyerSubject, found.saleId);
    const order = await lockOrder(tx, found.id);
    const items = await tx.orderItem.findMany({
      where: { orderId: order.id },
      orderBy: { seatId: 'asc' },
    });
    const seats = await lockSeats(
      tx,
      order.saleId,
      items.map((item) => item.seatId),
    );
    const now = await decisionTime(tx);
    const reason = refundReason(order, seats, items.length, now);
    const operationId = reason ? randomUUID() : null;
    if (reason) {
      if (order.state === 'HELD') await release(tx, order, 'EXPIRED');
      await enqueuePaymentOutcome(tx, event, 'PaymentRefundRequested.v1', {
        ...payment,
        operationId,
        reason,
      });
    } else {
      await confirmOrder(tx, event, payment, order, items, now);
    }
    await tx.paymentResult.create({
      data: { ...result, disposition: reason ? 'REFUND' : 'CONFIRMED', reason, operationId },
    });
  }
}
