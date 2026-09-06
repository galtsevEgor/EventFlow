import { ApiError } from '@eventflow/service-runtime';
import { Prisma, type Order, type SeatInventory } from '../generated/client';
import type { Database } from '../database';
import { z } from 'zod';

export type Transaction = Prisma.TransactionClient;
const adapterFailure = z.object({
  driverAdapterError: z.object({ cause: z.object({ originalCode: z.string() }) }),
});
const busy = () =>
  new ApiError(503, 'BOOKING_BUSY', 'Бронирование занято. Повторите тот же запрос.');

export async function transaction<T>(
  db: Database,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(run);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
      // The pg adapter wraps SQLSTATE; the binary engine exposes it directly in meta.code.
      const adapter = adapterFailure.safeParse(error.meta);
      const sqlState = adapter.success
        ? adapter.data.driverAdapterError.cause.originalCode
        : String(error.meta?.code);
      if (
        ['P2024', 'P2028', 'P1001', 'P1002', 'P1017'].includes(error.code) ||
        ['57014', '55P03'].includes(sqlState)
      )
        throw busy();
      const retryable = error.code === 'P2034' || ['40001', '40P01'].includes(sqlState);
      if (!retryable) throw error;
      if (attempt === 2) throw busy();
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
