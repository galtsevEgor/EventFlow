import { ApiError } from '@eventflow/service-runtime';
import { Database } from '../database';
import { decisionTime, lockOrder, lockSeats, lockSlot, transaction } from './transaction';
import { release } from './release';
import { orderView } from './view';

export class OrderLifecycle {
  constructor(private readonly db: Database) {}
  async cancel(buyer: string, id: string) {
    return this.finish(id, buyer, true);
  }
  async expire(id: string) {
    return this.finish(id, undefined, false);
  }
  private async finish(id: string, buyer: string | undefined, cancel: boolean) {
    return transaction(this.db, async (tx) => {
      const candidate = await tx.order.findFirst({
        where: { id, ...(buyer ? { buyerSubject: buyer } : {}) },
      });
      if (!candidate) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден.');
      if (cancel) await lockSlot(tx, candidate.buyerSubject, candidate.saleId);
      else {
        // Never take the order lock first: reserve always owns the buyer slot first.
        const slots = await tx.$queryRaw<{ saleId: string }[]>`
          SELECT "saleId" FROM "BuyerSaleSlot" WHERE "buyerSubject" = ${candidate.buyerSubject}
          AND "saleId" = ${candidate.saleId}::uuid FOR UPDATE SKIP LOCKED
        `;
        if (!slots.length) return;
      }
      const order = await lockOrder(tx, id);
      const items = await tx.orderItem.findMany({
        where: { orderId: id },
        orderBy: [{ row: 'asc' }, { number: 'asc' }],
      });
      await lockSeats(
        tx,
        order.saleId,
        items.map((item) => item.seatId),
      );
      const now = await decisionTime(tx);
      if (cancel && order.state === 'CONFIRMED')
        throw new ApiError(
          409,
          'ORDER_CONFIRMED',
          'Подтверждённый заказ нельзя отменить этой операцией.',
        );
      if (order.state === 'HELD' && (cancel || order.expiresAt <= now)) {
        const state = order.expiresAt <= now ? 'EXPIRED' : 'CANCELLED';
        await release(tx, order, state);
        order.state = state;
      }
      return orderView({ ...order, items }, now);
    });
  }
}
