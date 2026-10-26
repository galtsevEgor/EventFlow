import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseInput, type SecretBox } from '@eventflow/service-runtime';
import type { Prisma, Sale } from '../generated/client';
import { Database } from '../database';
import { salesState } from '../sale-reader';
import {
  decisionTime,
  lockOrder,
  lockSeats,
  lockSlot,
  transaction,
  type Transaction,
} from './transaction';
import { orderView } from './view';
import { release } from './release';
import { recordOrderStatistics } from './statistics';

export const reserveInput = z.strictObject({
  saleId: z.uuid().transform((value) => value.toLowerCase()),
  seatIds: z
    .array(z.string().regex(/^r\d{1,2}-s\d{1,2}$/))
    .min(1)
    .max(6)
    .refine((ids) => new Set(ids).size === ids.length, 'Выберите разные места.'),
});
type Input = z.infer<typeof reserveInput>;
type Result = { status: number; body: Prisma.InputJsonObject };
const failure = (status: number, code: string, message: string): Result => ({
  status,
  body: { code, message },
});

export class Reserve {
  constructor(
    private readonly db: Database,
    private readonly contactBox?: SecretBox,
  ) {}
  async run(
    buyer: string,
    keyInput: unknown,
    input: unknown,
    email?: string,
    analyticsSessionId?: string,
  ): Promise<Result> {
    return this.execute(
      buyer,
      keyInput,
      parseInput(reserveInput, input),
      email,
      analyticsSessionId,
    );
  }
  async category(
    buyer: string,
    key: string,
    saleId: string,
    categoryId: string,
    entryId: string,
    email: string,
  ) {
    return this.execute(buyer, key, { saleId, seatIds: [] }, email, undefined, {
      id: categoryId,
      entryId,
    });
  }
  private async execute(
    buyer: string,
    keyInput: unknown,
    data: Input,
    email?: string,
    analyticsSessionId?: string,
    category?: { id: string; entryId: string },
  ): Promise<Result> {
    const key = parseInput(z.uuid(), keyInput).toLowerCase();
    const hash = createHash('sha256')
      .update(
        JSON.stringify(
          category
            ? { saleId: data.saleId, category }
            : { saleId: data.saleId, seatIds: [...data.seatIds].sort() },
        ),
      )
      .digest('hex');
    return transaction(this.db, async (tx) => {
      // A key is scoped to the buyer, including retries that accidentally name another sale.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reserve:${buyer}:${key}`}, 0))`;
      const previous = await tx.reservationRequest.findUnique({
        where: { buyerSubject_key: { buyerSubject: buyer, key } },
      });
      if (previous) {
        if (previous.payloadHash !== hash)
          return failure(409, 'IDEMPOTENCY_CONFLICT', 'Ключ уже использован для другого запроса.');
        return {
          status: previous.status,
          body: z.record(z.string(), z.json()).parse(previous.response),
        };
      }
      const result = await this.create(tx, buyer, data, email, analyticsSessionId, category);
      await tx.reservationRequest.create({
        data: {
          buyerSubject: buyer,
          key,
          payloadHash: hash,
          status: result.status,
          response: result.body,
        },
      });
      return result;
    });
  }

  private async create(
    tx: Transaction,
    buyer: string,
    data: Input,
    email?: string,
    analyticsSessionId?: string,
    category?: { id: string; entryId: string },
  ): Promise<Result> {
    // SHARE permits concurrent buyers but conflicts with the pause UPDATE.
    const [sale] = await tx.$queryRaw<
      Sale[]
    >`SELECT * FROM "Sale" WHERE id = ${data.saleId}::uuid FOR SHARE`;
    if (!sale) return failure(404, 'NOT_FOUND', 'Продажа не найдена.');
    const slot = await lockSlot(tx, buyer, sale.id);
    const old = slot.currentOrderId ? await lockOrder(tx, slot.currentOrderId) : undefined;
    const oldItems = old ? await tx.orderItem.findMany({ where: { orderId: old.id } }) : [];
    const candidates = category
      ? await tx.seatInventory.findMany({
          where: { saleId: sale.id, categoryId: category.id },
          select: { seatId: true },
        })
      : [];
    const seats = await lockSeats(tx, sale.id, [
      ...(category ? candidates.map((s) => s.seatId) : data.seatIds),
      ...oldItems.map((item) => item.seatId),
    ]);
    const now = await decisionTime(tx);
    if (old?.state === 'HELD' && old.expiresAt <= now) await release(tx, old, 'EXPIRED');
    else if (old?.state === 'HELD')
      return failure(409, 'ACTIVE_ORDER', 'У вас уже есть бронь на это мероприятие.');
    if (salesState(sale, now) !== 'OPEN')
      return failure(409, 'SALES_NOT_OPEN', 'Новые брони сейчас недоступны.');
    if (category) {
      if (
        await tx.order.count({
          where: { saleId: sale.id, buyerSubject: buyer, state: 'CONFIRMED' },
        })
      )
        return failure(409, 'ALREADY_PURCHASED', 'Билет уже приобретён.');
      const available = seats.find(
        (s) =>
          s.categoryId === category.id &&
          (s.state === 'AVAILABLE' || (s.state === 'HELD' && s.expiresAt && s.expiresAt <= now)),
      );
      if (!available) return failure(409, 'SEATS_UNAVAILABLE', 'Свободных мест пока нет.');
      data = { ...data, seatIds: [available.seatId] };
    }
    const selected = seats.filter((seat) => data.seatIds.includes(seat.seatId));
    if (selected.length !== data.seatIds.length)
      return failure(422, 'INVALID_SEATS', 'Места не принадлежат этому мероприятию.');
    if (
      selected.some(
        (seat) =>
          seat.state === 'SOLD' ||
          (seat.state === 'HELD' && seat.expiresAt && seat.expiresAt > now),
      )
    )
      return failure(409, 'SEATS_UNAVAILABLE', 'Одно из мест уже занято. Обновите выбор.');
    const expiresAt = new Date(Math.min(+now + 600000, +sale.salesEndsAt));
    const id = randomUUID();
    const order = await tx.order.create({
      data: {
        id,
        contactEmail: email && this.contactBox ? this.contactBox.seal(email, id) : null,
        saleId: sale.id,
        buyerSubject: buyer,
        analyticsSessionId: analyticsSessionId ?? null,
        waitlistEntryId: category?.entryId ?? null,
        organizationId: sale.organizationId,
        title: sale.title,
        currency: sale.currency,
        totalMinor: selected.reduce((sum, seat) => sum + seat.priceMinor, 0),
        createdAt: now,
        expiresAt,
        items: {
          create: selected.map(({ seatId, row, number, categoryName, priceMinor }) => ({
            seatId,
            row,
            number,
            categoryName,
            priceMinor,
          })),
        },
      },
      include: { items: { orderBy: [{ row: 'asc' }, { number: 'asc' }] } },
    });
    await tx.seatInventory.updateMany({
      where: { saleId: sale.id, seatId: { in: data.seatIds } },
      data: {
        state: 'HELD',
        currentOrderId: order.id,
        expiresAt,
        version: { increment: 1 },
      },
    });
    await tx.buyerSaleSlot.update({
      where: { buyerSubject_saleId: { buyerSubject: buyer, saleId: sale.id } },
      data: { currentOrderId: order.id },
    });
    await recordOrderStatistics(tx, order.id);
    return { status: 201, body: orderView(order, now) };
  }
}
