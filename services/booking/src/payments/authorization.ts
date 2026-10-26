import { ApiError } from '@eventflow/service-runtime';
import type { Database } from '../database';
import {
  decisionTime,
  effectiveState,
  lockOrder,
  lockSlot,
  transaction,
} from '../orders/transaction';
import type { Order } from '../generated/client';

function snapshot(order: Order, now: Date) {
  return {
    orderId: order.id,
    buyerSubject: order.buyerSubject,
    amountMinor: order.totalMinor,
    currency: order.currency,
    expiresAt: order.expiresAt.toISOString(),
    serverNow: now.toISOString(),
    state: effectiveState(order, now),
  };
}
export class PaymentAuthorization {
  constructor(private readonly db: Database) {}
  async read(id: string, buyer?: string, serialized = false) {
    return transaction(this.db, async (tx) => {
      const order = await tx.order.findFirst({
        where: { id, ...(buyer ? { buyerSubject: buyer } : {}) },
      });
      if (!order) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден.');
      if (serialized) {
        await lockSlot(tx, order.buyerSubject, order.saleId);
        const current = await lockOrder(tx, id);
        return snapshot(current, await decisionTime(tx));
      }
      return snapshot(order, await decisionTime(tx));
    });
  }
  async authorize(id: string, attemptId: string, buyer: string, provider: 'fake' | 'stripe') {
    return transaction(this.db, async (tx) => {
      const found = await tx.order.findFirst({ where: { id, buyerSubject: buyer } });
      if (!found) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден.');
      await lockSlot(tx, buyer, found.saleId);
      const order = await lockOrder(tx, id);
      const now = await decisionTime(tx);
      const result = snapshot(order, now);
      const existing = await tx.paymentAuthorization.findUnique({ where: { orderId: id } });
      if (existing && (existing.attemptId !== attemptId || existing.provider !== provider))
        throw new ApiError(409, 'PAYMENT_ATTEMPT_EXISTS', 'Для заказа уже создана попытка оплаты.');
      if (!existing && result.state === 'HELD')
        await tx.paymentAuthorization.create({ data: { attemptId, orderId: id, provider } });
      return result;
    });
  }
}
