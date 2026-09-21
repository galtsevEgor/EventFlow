import { ApiError } from '@eventflow/service-runtime';
import { Database } from '../database';
import { decisionTime } from './transaction';
import { orderView } from './view';

export class OrderReader {
  constructor(private readonly db: Database) {}
  async read(buyer: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id, buyerSubject: buyer },
        include: { items: { orderBy: [{ row: 'asc' }, { number: 'asc' }] }, refund: true },
      });
      if (!order) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден.');
      return orderView(order, await decisionTime(tx));
    });
  }
  async list(buyer: string, page: number, saleId?: string) {
    return this.db.$transaction(
      async (tx) => {
        const where = { buyerSubject: buyer, ...(saleId ? { saleId } : {}) };
        const orders = await tx.order.findMany({
          where,
          take: 20,
          skip: (page - 1) * 20,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: { items: { orderBy: [{ row: 'asc' }, { number: 'asc' }] }, refund: true },
        });
        const now = await decisionTime(tx);
        return {
          items: orders.map((order) => orderView(order, now)),
          total: await tx.order.count({ where }),
          page,
          pageSize: 20,
          serverNow: now.toISOString(),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
