import { ApiError } from '@eventflow/service-runtime';
import { Database } from './database';

type Window = { salesStartsAt: Date; salesEndsAt: Date; paused: boolean };
export function salesState(sale: Window, now: Date) {
  if (now >= sale.salesEndsAt) return 'CLOSED';
  if (now < sale.salesStartsAt) return 'SCHEDULED';
  return sale.paused ? 'PAUSED' : 'OPEN';
}
export class SaleReader {
  constructor(private readonly db: Database) {}
  async read(id: string) {
    return this.db.$transaction(async (tx) => {
      const sale = await tx.sale.findUnique({
        where: { id },
        include: { seats: { orderBy: [{ row: 'asc' }, { number: 'asc' }] } },
      });
      if (!sale) throw new ApiError(404, 'NOT_FOUND', 'Продажа не найдена.');
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('Database clock unavailable');
      return {
        id: sale.id,
        currency: sale.currency,
        state: salesState(sale, clock.now),
        serverNow: clock.now,
        salesStartsAt: sale.salesStartsAt,
        salesEndsAt: sale.salesEndsAt,
        paused: sale.paused,
        commandVersion: sale.commandVersion,
        seats: sale.seats.map(
          ({ seatId, row, number, categoryId, categoryName, priceMinor, state, expiresAt }) => ({
            seatId,
            row,
            number,
            categoryId,
            categoryName,
            priceMinor,
            state: state === 'HELD' && expiresAt && expiresAt <= clock.now ? 'AVAILABLE' : state,
          }),
        ),
      };
    });
  }
}
