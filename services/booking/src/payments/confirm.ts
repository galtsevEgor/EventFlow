import { createHash, randomUUID } from 'node:crypto';
import { message, paymentSucceededSchema, type EventEnvelope } from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import type { Database } from '../database';
import { decisionTime, lockOrder, lockSeats, lockSlot, transaction } from '../orders/transaction';
import { release } from '../orders/release';

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
    const payment = parsed.data;
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          orderId: payment.orderId,
          attemptId: payment.attemptId,
          providerPaymentId: payment.providerPaymentId,
          buyerSubject: payment.buyerSubject,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          provider: payment.provider,
        }),
      )
      .digest('hex');
    await transaction(this.db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${payment.providerPaymentId}, 1))`;
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      const send = async (type: string, data: EventEnvelope['data']) => {
        const reply = message('booking', type, payment.orderId, 2, data, event);
        await tx.outbox.create({ data: { id: reply.eventId, envelope: reply } });
      };
      const review = async (code: string) =>
        send('PaymentReviewRequired.v1', {
          orderId: payment.orderId,
          attemptId: payment.attemptId,
          providerPaymentId: payment.providerPaymentId,
          code,
        });
      const previous = await tx.paymentResult.findUnique({
        where: { providerPaymentId: payment.providerPaymentId },
      });
      if (previous) {
        if (previous.payloadHash !== payloadHash) await review('PAYMENT_BINDING_CHANGED');
        await tx.inbox.create({ data: { eventId: event.eventId } });
        return;
      }
      const found = await tx.order.findUnique({ where: { id: payment.orderId } });
      const authorization = await tx.paymentAuthorization.findUnique({
        where: { attemptId: payment.attemptId },
      });
      const bindingValid =
        found &&
        authorization?.orderId === found.id &&
        authorization.provider === payment.provider &&
        found.buyerSubject === payment.buyerSubject &&
        found.totalMinor === payment.amountMinor &&
        found.currency === payment.currency;
      if (!bindingValid) {
        await tx.paymentResult.create({
          data: {
            providerPaymentId: payment.providerPaymentId,
            orderId: payment.orderId,
            attemptId: payment.attemptId,
            payloadHash,
            disposition: 'REVIEW',
            reason: 'PAYMENT_BINDING_MISMATCH',
          },
        });
        await review('PAYMENT_BINDING_MISMATCH');
      } else {
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
        const ownsSeats =
          seats.length === items.length &&
          items.length > 0 &&
          seats.every(
            (seat) =>
              seat.state === 'HELD' &&
              seat.currentOrderId === order.id &&
              seat.expiresAt !== null &&
              seat.expiresAt > now,
          );
        const reason =
          order.state === 'CONFIRMED'
            ? 'EXTRA_PAYMENT'
            : order.state === 'CANCELLED'
              ? 'ORDER_CANCELLED'
              : order.state === 'EXPIRED' || now >= order.expiresAt
                ? 'HOLD_EXPIRED'
                : !ownsSeats
                  ? 'SEATS_LOST'
                  : null;
        const operationId = reason ? randomUUID() : null;
        if (reason) {
          if (order.state === 'HELD') await release(tx, order, 'EXPIRED');
          const refund = {
            orderId: payment.orderId,
            attemptId: payment.attemptId,
            providerPaymentId: payment.providerPaymentId,
            buyerSubject: payment.buyerSubject,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            provider: payment.provider,
          };
          await send('PaymentRefundRequested.v1', { ...refund, operationId, reason });
        } else {
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
          await send('OrderConfirmed.v1', {
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
        }
        await tx.paymentResult.create({
          data: {
            providerPaymentId: payment.providerPaymentId,
            orderId: payment.orderId,
            attemptId: payment.attemptId,
            payloadHash,
            disposition: reason ? 'REFUND' : 'CONFIRMED',
            reason,
            operationId,
          },
        });
      }
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }
}
