import { ApiError } from '@eventflow/service-runtime';
import { Prisma, type Order, type SeatInventory } from '../generated/client';
import type { Database } from '../database';

export type Transaction = Prisma.TransactionClient;

export async function transaction<T>(
  db: Database,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(run);
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || ['40001', '40P01'].includes(String(error.meta?.code)));
      if (!retryable) throw error;
      if (attempt === 2)
        throw new ApiError(503, 'BOOKING_BUSY', 'Бронирование занято. Повторите тот же запрос.');
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

export async function decisionTime(tx: Transaction) {
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now
  `;
  if (!clock) throw new Error('Database clock unavailable');
  return clock.now;
}

export async function lockSlot(tx: Transaction, buyer: string, saleId: string) {
  await tx.$executeRaw`
    INSERT INTO "BuyerSaleSlot" ("buyerSubject", "saleId") VALUES (${buyer}, ${saleId}::uuid)
    ON CONFLICT DO NOTHING
  `;
  const [slot] = await tx.$queryRaw<{ currentOrderId: string | null }[]>`
    SELECT "currentOrderId" FROM "BuyerSaleSlot"
    WHERE "buyerSubject" = ${buyer} AND "saleId" = ${saleId}::uuid FOR UPDATE
  `;
  if (!slot) throw new Error('Buyer slot missing');
  return slot;
}

export async function lockOrder(tx: Transaction, id: string) {
  const [order] = await tx.$queryRaw<
    Order[]
  >`SELECT * FROM "Order" WHERE id = ${id}::uuid FOR UPDATE`;
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден.');
  return order;
}

export async function lockSeats(tx: Transaction, saleId: string, ids: string[]) {
  if (!ids.length) return [];
  return tx.$queryRaw<SeatInventory[]>(Prisma.sql`
    SELECT * FROM "SeatInventory" WHERE "saleId" = ${saleId}::uuid
    AND "seatId" IN (${Prisma.join([...new Set(ids)])})
    ORDER BY "seatId" COLLATE "C" FOR UPDATE
  `);
}

export function effectiveState(order: Pick<Order, 'state' | 'expiresAt'>, now: Date) {
  return order.state === 'HELD' && now >= order.expiresAt ? 'EXPIRED' : order.state;
}
