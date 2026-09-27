import { createHash, randomUUID } from 'node:crypto';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import { message, organizerRefundInput, ticketRefundLockSchema } from '@eventflow/event-contracts';
import { z } from 'zod';
import { Database } from '../database';
import { decisionTime, lockOrder, transaction } from '../orders/transaction';
import { orderView } from '../orders/view';
import { RefundAccess } from './access';
import { refundView } from './view';
import { refundUpdate } from './updates';

export class OrganizerRefunds {
  constructor(
    private readonly db: Database,
    private readonly access: RefundAccess,
  ) {}

  async list(actor: string, organizationId: string, saleId: string, page: number) {
    await this.access.check(actor, organizationId, saleId);
    return this.db.$transaction(
      async (tx) => {
        const sale = await tx.sale.findFirst({ where: { id: saleId, organizationId } });
        if (!sale) throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
        const where = {
          organizationId,
          saleId,
          state: { in: ['CONFIRMED', 'REFUNDED'] as ('CONFIRMED' | 'REFUNDED')[] },
        };
        const orders = await tx.order.findMany({
          where,
          take: 20,
          skip: (page - 1) * 20,
          orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
          include: { items: { orderBy: [{ row: 'asc' }, { number: 'asc' }] }, refund: true },
        });
        const now = await decisionTime(tx);
        const total = await tx.order.count({ where });
        return {
          orders: orders.map((order) => ({
            ...orderView(order, now),
            refundDeadline: sale.startsAt.toISOString(),
            canRequestRefund: order.state === 'CONFIRMED' && !order.refund && now < sale.startsAt,
          })),
          total,
          page,
          pageSize: 20,
          pages: Math.ceil(total / 20),
          serverNow: now.toISOString(),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async request(
    actor: string,
    organizationId: string,
    saleId: string,
    orderId: string,
    rawKey: unknown,
    input: unknown,
  ) {
    const key = parseInput(z.uuid(), rawKey).toLowerCase();
    const { reason } = parseInput(organizerRefundInput, input);
    await this.access.check(actor, organizationId, saleId);
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ organizationId, saleId, orderId, reason }))
      .digest('hex');
    return transaction(this.db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`refund:${actor}:${key}`}, 0))`;
      const previous = await tx.refundRequest.findUnique({
        where: { actorSubject_key: { actorSubject: actor, key } },
      });
      if (previous) {
        if (previous.payloadHash !== payloadHash)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Ключ использован для другого возврата.');
        return refundView(
          await tx.orderRefund.findUniqueOrThrow({ where: { id: previous.operationId } }),
        );
      }
      const candidate = await tx.order.findFirst({
        where: { id: orderId, saleId, organizationId },
      });
      if (!candidate) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден.');
      const order = await lockOrder(tx, orderId);
      let refund = await tx.orderRefund.findUnique({ where: { orderId } });
      if (refund && refund.reason !== reason)
        throw new ApiError(
          409,
          'REFUND_EXISTS',
          'Для заказа уже оформлен запрос возврата. Обновите статус.',
        );
      if (!refund) {
        const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId } });
        const now = await decisionTime(tx);
        if (order.state !== 'CONFIRMED')
          throw new ApiError(
            409,
            'ORDER_NOT_CONFIRMED',
            'Возврат доступен для оплаченного заказа.',
          );
        if (now >= sale.startsAt)
          throw new ApiError(409, 'REFUND_WINDOW_CLOSED', 'Срок возврата закончился.');
        const authorization = await tx.paymentAuthorization.findUnique({ where: { orderId } });
        const payment = order.confirmedPaymentId
          ? await tx.paymentResult.findUnique({
              where: { providerPaymentId: order.confirmedPaymentId },
            })
          : null;
        if (
          !authorization ||
          !payment ||
          payment.disposition !== 'CONFIRMED' ||
          payment.attemptId !== authorization.attemptId
        )
          throw new ApiError(
            409,
            'PAYMENT_NOT_READY',
            'Подтверждение оплаты ещё недоступно для возврата.',
          );
        refund = await tx.orderRefund.create({
          data: {
            id: randomUUID(),
            orderId,
            actorSubject: actor,
            reason,
            createdAt: now,
            updatedAt: now,
          },
        });
        const items = await tx.orderItem.findMany({
          where: { orderId },
          orderBy: { seatId: 'asc' },
        });
        const data = ticketRefundLockSchema.parse({
          operationId: refund.id,
          orderId,
          saleId,
          organizationId,
          seatIds: items.map((item) => item.seatId),
          deadline: sale.startsAt.toISOString(),
        });
        const event = message('booking', 'TicketRefundLockRequested.v1', orderId, 1, data);
        await tx.outbox.create({ data: { id: event.eventId, envelope: event } });
        await refundUpdate(tx, order);
      }
      await tx.refundRequest.create({
        data: { actorSubject: actor, key, payloadHash, operationId: refund.id },
      });
      return refundView(refund);
    });
  }
}
