import type { Prisma } from './generated/client.ts';

export class SeatUnavailable extends Error {}

// E0 experiment only: the caller owns the transaction; this is not the booking domain API.
export async function reserveSeats(
  transaction: Prisma.TransactionClient,
  seatIds: readonly number[],
  orderId: string,
) {
  if (seatIds.length < 1 || seatIds.length > 6 || new Set(seatIds).size !== seatIds.length) {
    throw new Error('Choose 1–6 distinct seats');
  }
  for (const id of [...seatIds].sort((left, right) => left - right)) {
    const [seat] = await transaction.$queryRaw<{ id: number; order_id: string | null }[]>`
      SELECT id, order_id FROM seat WHERE id = ${id} FOR UPDATE
    `;
    if (!seat || seat.order_id !== null) throw new SeatUnavailable(`Seat ${id} is unavailable`);
  }
  await transaction.seat.updateMany({ where: { id: { in: [...seatIds] } }, data: { orderId } });
}
