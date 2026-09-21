import {
  confirmedRefundCommandSchema,
  message,
  orderRefundedSchema,
  refundOutcomeSchema,
  ticketRefundResultSchema,
  type EventEnvelope,
} from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import type { Database } from '../database';
import { decisionTime, lockOrder, lockSeats, lockSlot, transaction } from '../orders/transaction';

export class RefundWorkflow {
  constructor(private readonly db: Database) {}

  async handle(event: EventEnvelope) {
    if (['TicketRefundLocked.v1', 'TicketRefundLockRejected.v1'].includes(event.eventType))
      return this.locked(event);
    return this.outcome(event);
  }

  private async locked(event: EventEnvelope) {
    const parsed = ticketRefundResultSchema.safeParse(event.data);
    if (
      event.producer !== 'tickets' ||
      !parsed.success ||
      parsed.data.orderId !== event.aggregateId ||
      (event.eventType === 'TicketRefundLocked.v1') !== (parsed.data.code === null)
    )
      throw new PermanentMessageError('Invalid refund lock result');
    const data = parsed.data;
    await transaction(this.db, async (tx) => {
      const order = await lockOrder(tx, data.orderId);
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      const refund = await tx.orderRefund.findUnique({ where: { id: data.operationId } });
      if (
        !refund ||
        refund.orderId !== order.id ||
        order.saleId !== data.saleId ||
        order.organizationId !== data.organizationId
      )
        throw new PermanentMessageError('Refund lock scope mismatch');
      if (refund.state === 'FENCING') {
        const now = await decisionTime(tx);
        if (data.code)
          await tx.orderRefund.update({
            where: { id: refund.id },
            data: { state: 'REJECTED', code: data.code, updatedAt: now },
          });
        else {
          const auth = await tx.paymentAuthorization.findUnique({ where: { orderId: order.id } });
          const payment = order.confirmedPaymentId
            ? await tx.paymentResult.findUnique({
                where: { providerPaymentId: order.confirmedPaymentId },
              })
            : null;
          if (
            order.state !== 'CONFIRMED' ||
            !auth ||
            !payment ||
            payment.disposition !== 'CONFIRMED' ||
            payment.attemptId !== auth.attemptId ||
            payment.orderId !== order.id
          )
            throw new PermanentMessageError('Refund payment binding unavailable');
          const command = confirmedRefundCommandSchema.parse({
            operationId: refund.id,
            orderId: order.id,
            attemptId: auth.attemptId,
            providerPaymentId: payment.providerPaymentId,
            buyerSubject: order.buyerSubject,
            amountMinor: order.totalMinor,
            currency: order.currency,
            provider: auth.provider,
            reason: 'ORGANIZER_REQUESTED',
          });
          const next = message('booking', 'ConfirmedOrderRefundRequested.v1', order.id, 1, command);
          await tx.outbox.create({ data: { id: next.eventId, envelope: next } });
          await tx.orderRefund.update({
            where: { id: refund.id },
            data: { state: 'PENDING', updatedAt: now },
          });
        }
      }
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }

  private async outcome(event: EventEnvelope) {
    const parsed = refundOutcomeSchema.safeParse(event.data);
    if (
      event.producer !== 'payments' ||
      !['ConfirmedOrderRefundSucceeded.v1', 'ConfirmedOrderRefundReviewRequired.v1'].includes(
        event.eventType,
      ) ||
      !parsed.success ||
      parsed.data.orderId !== event.aggregateId ||
      (event.eventType === 'ConfirmedOrderRefundSucceeded.v1') !==
        (parsed.data.state === 'SUCCEEDED')
    )
      throw new PermanentMessageError('Invalid confirmed refund outcome');
    const data = parsed.data;
    await transaction(this.db, async (tx) => {
      const candidate = await tx.order.findUnique({ where: { id: data.orderId } });
      if (!candidate) throw new PermanentMessageError('Unknown refunded order');
      await lockSlot(tx, candidate.buyerSubject, candidate.saleId);
      const order = await lockOrder(tx, candidate.id);
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      const refund = await tx.orderRefund.findUnique({ where: { id: data.operationId } });
      const auth = await tx.paymentAuthorization.findUnique({ where: { orderId: order.id } });
      const payment = await tx.paymentResult.findUnique({
        where: { providerPaymentId: data.providerPaymentId },
      });
      if (
        !refund ||
        refund.orderId !== order.id ||
        !['PENDING', 'REQUIRES_REVIEW', 'SUCCEEDED'].includes(refund.state) ||
        !auth ||
        auth.attemptId !== data.attemptId ||
        !payment ||
        payment.attemptId !== data.attemptId ||
        payment.orderId !== order.id ||
        payment.disposition !== 'CONFIRMED' ||
        order.confirmedPaymentId !== data.providerPaymentId ||
        !order.confirmedAt
      )
        throw new PermanentMessageError('Confirmed refund binding mismatch');
      if (refund.state !== 'SUCCEEDED') {
        const now = await decisionTime(tx);
        if (data.state !== 'SUCCEEDED')
          await tx.orderRefund.update({
            where: { id: refund.id },
            data: { state: 'REQUIRES_REVIEW', code: data.code, updatedAt: now },
          });
        else {
          const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
          const seats = await lockSeats(
            tx,
            order.saleId,
            items.map((item) => item.seatId),
          );
          if (
            order.state !== 'CONFIRMED' ||
            seats.length !== items.length ||
            seats.some((seat) => seat.state !== 'SOLD' || seat.currentOrderId !== order.id)
          )
            throw new PermanentMessageError('Refund inventory ownership mismatch');
          await tx.seatInventory.updateMany({
            where: { saleId: order.saleId, currentOrderId: order.id, state: 'SOLD' },
            data: {
              state: 'AVAILABLE',
              currentOrderId: null,
              expiresAt: null,
              version: { increment: 1 },
            },
          });
          await tx.order.update({ where: { id: order.id }, data: { state: 'REFUNDED' } });
          await tx.orderRefund.update({
            where: { id: refund.id },
            data: {
              state: 'SUCCEEDED',
              code: null,
              completedAt: new Date(event.occurredAt),
              updatedAt: now,
            },
          });
          const snapshot = orderRefundedSchema.parse({
            operationId: refund.id,
            orderId: order.id,
            saleId: order.saleId,
            organizationId: order.organizationId,
            attemptId: data.attemptId,
            providerPaymentId: data.providerPaymentId,
            state: 'REFUNDED',
            seatCount: items.length,
            totalMinor: order.totalMinor,
            currency: order.currency,
            createdAt: order.createdAt.toISOString(),
            expiresAt: order.expiresAt.toISOString(),
            confirmedAt: order.confirmedAt.toISOString(),
            refundedAt: event.occurredAt,
          });
          const next = message('booking', 'OrderRefunded.v1', order.id, 3, snapshot);
          await tx.outbox.create({ data: { id: next.eventId, envelope: next } });
        }
      }
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }
}
