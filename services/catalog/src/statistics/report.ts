import { z } from 'zod';
import { ApiError, parseInput, type UserIdentity } from '@eventflow/service-runtime';
import { Database } from '../database';
import { Prisma } from '../generated/client';
import { requireMembership } from '../organizations/access';

const querySchema = z.strictObject({
  eventId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
type Metrics = {
  capacity: bigint;
  soldSeats: bigint;
  heldSeats: bigint;
  availableSeats: bigint;
  confirmedOrders: bigint;
  revenueMinor: bigint;
  paidMinor: bigint;
  refundedMinor: bigint;
};
function number(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new ApiError(503, 'STATISTICS_TOO_LARGE', 'Сузьте период или выберите мероприятие.');
  return result;
}
function metrics(row: Metrics) {
  return {
    capacity: number(row.capacity),
    soldSeats: number(row.soldSeats),
    heldSeats: number(row.heldSeats),
    availableSeats: number(row.availableSeats),
    confirmedOrders: number(row.confirmedOrders),
    revenueMinor: number(row.revenueMinor),
    paidMinor: number(row.paidMinor),
    refundedMinor: number(row.refundedMinor),
    netMinor: number(row.paidMinor - row.refundedMinor),
  };
}

export class StatisticsReport {
  constructor(private readonly db: Database) {}

  async get(actor: UserIdentity, organizationId: string, input: unknown) {
    const query = parseInput(querySchema, input);
    return this.db.$transaction(
      async (tx) => {
        await requireMembership(tx, actor, organizationId, ['OWNER', 'MANAGER']);
        if (
          query.eventId &&
          !(await tx.publicEvent.findFirst({
            where: { eventId: query.eventId, event: { organizationId } },
            select: { eventId: true },
          }))
        )
          throw new ApiError(404, 'NOT_FOUND', 'Опубликованное мероприятие не найдено.');
        const [clock] = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT date_trunc('milliseconds', statement_timestamp()) AS now`;
        if (!clock) throw new Error('Database clock unavailable');
        const to = query.to ?? clock.now.toISOString().slice(0, 10);
        const from =
          query.from ?? new Date(+new Date(to) - 29 * 86400000).toISOString().slice(0, 10);
        const start = new Date(from + 'T00:00:00Z');
        const until = new Date(+new Date(to + 'T00:00:00Z') + 86400000);
        const days = (+until - +start) / 86400000;
        if (!Number.isFinite(days) || days < 1 || days > 366)
          throw new ApiError(422, 'INVALID_INPUT', 'Выберите период от 1 до 366 дней.');

        const base = Prisma.sql`
        WITH events AS (
          SELECT e.id, e.title, p.capacity, p."startsAt" FROM "EventDraft" e
          JOIN "PublicEvent" p ON p."eventId" = e.id
          WHERE e."organizationId" = ${organizationId}::uuid
            ${query.eventId ? Prisma.sql`AND e.id = ${query.eventId}::uuid` : Prisma.empty}
        ), orders AS (
          SELECT o.* FROM "SalesOrder" o JOIN events e ON e.id = o."eventId"
          WHERE o."organizationId" = ${organizationId}::uuid
        ), order_totals AS (
          SELECT "eventId",
            coalesce(sum("seatCount") FILTER (WHERE state = 'CONFIRMED'), 0)::bigint AS "soldSeats",
            coalesce(sum("seatCount") FILTER (WHERE state = 'HELD' AND "expiresAt" > ${clock.now}), 0)::bigint AS "heldSeats",
            count(*) FILTER (WHERE state IN ('CONFIRMED','REFUNDED') AND "confirmedAt" >= ${start} AND "confirmedAt" < ${until}) AS "confirmedOrders",
            coalesce(sum("totalMinor") FILTER (WHERE state IN ('CONFIRMED','REFUNDED') AND "confirmedAt" >= ${start} AND "confirmedAt" < ${until}), 0)::bigint AS "revenueMinor",
            max("updatedAt") AS "updatedAt"
          FROM orders GROUP BY "eventId"
        ), payment_totals AS (
          SELECT o."eventId",
            coalesce(sum(p."amountMinor") FILTER (WHERE p."verifiedAt" >= ${start} AND p."verifiedAt" < ${until}), 0)::bigint AS "paidMinor",
            max(p."updatedAt") AS "updatedAt"
          FROM "SalesPayment" p JOIN orders o ON o."orderId" = p."orderId"
            AND p."amountMinor" = o."totalMinor" AND p.currency = o.currency
          GROUP BY o."eventId"
        ), refund_totals AS (
          SELECT o."eventId",
            coalesce(sum(p."amountMinor") FILTER (WHERE r."completedAt" >= ${start} AND r."completedAt" < ${until}), 0)::bigint AS "refundedMinor",
            max(r."updatedAt") AS "updatedAt"
          FROM "SalesRefund" r JOIN "SalesPayment" p ON p."attemptId" = r."attemptId"
            AND p."orderId" = r."orderId" AND p."providerPaymentId" = r."providerPaymentId"
          JOIN orders o ON o."orderId" = p."orderId" AND p."amountMinor" = o."totalMinor" AND p.currency = o.currency
          GROUP BY o."eventId"
        ), metrics AS (
          SELECT e.*, coalesce(o."soldSeats", 0)::bigint AS "soldSeats",
            coalesce(o."heldSeats", 0)::bigint AS "heldSeats",
            greatest(0, e.capacity - coalesce(o."soldSeats", 0) - coalesce(o."heldSeats", 0))::bigint AS "availableSeats",
            coalesce(o."confirmedOrders", 0)::bigint AS "confirmedOrders",
            coalesce(o."revenueMinor", 0)::bigint AS "revenueMinor",
            coalesce(p."paidMinor", 0)::bigint AS "paidMinor",
            coalesce(r."refundedMinor", 0)::bigint AS "refundedMinor",
            greatest(o."updatedAt", p."updatedAt", r."updatedAt") AS "updatedAt"
          FROM events e LEFT JOIN order_totals o ON o."eventId" = e.id
          LEFT JOIN payment_totals p ON p."eventId" = e.id
          LEFT JOIN refund_totals r ON r."eventId" = e.id
        )`;
        const [summary] = await tx.$queryRaw<
          (Metrics & { total: bigint; updatedAt: Date | null })[]
        >`${base}
        SELECT count(*) AS total, max("updatedAt") AS "updatedAt",
          coalesce(sum(capacity), 0)::bigint AS capacity,
          coalesce(sum("soldSeats"), 0)::bigint AS "soldSeats",
          coalesce(sum("heldSeats"), 0)::bigint AS "heldSeats",
          coalesce(sum("availableSeats"), 0)::bigint AS "availableSeats",
          coalesce(sum("confirmedOrders"), 0)::bigint AS "confirmedOrders",
          coalesce(sum("revenueMinor"), 0)::bigint AS "revenueMinor",
          coalesce(sum("paidMinor"), 0)::bigint AS "paidMinor",
          coalesce(sum("refundedMinor"), 0)::bigint AS "refundedMinor"
        FROM metrics`;
        if (!summary) throw new Error('Statistics summary unavailable');
        const rows = await tx.$queryRaw<
          (Metrics & { id: string; title: string; startsAt: Date; updatedAt: Date | null })[]
        >`${base}
        SELECT * FROM metrics ORDER BY "startsAt" DESC, id
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
        const daily = await tx.$queryRaw<
          { date: string; confirmedOrders: bigint; revenueMinor: bigint }[]
        >`${base}
        SELECT to_char("confirmedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
          count(*) AS "confirmedOrders", sum("totalMinor")::bigint AS "revenueMinor"
        FROM orders WHERE state IN ('CONFIRMED','REFUNDED') AND "confirmedAt" >= ${start} AND "confirmedAt" < ${until}
        GROUP BY date ORDER BY date`;
        const byDate = new Map(daily.map((row) => [row.date, row]));
        const series = Array.from({ length: days }, (_, i) => {
          const date = new Date(+start + i * 86400000).toISOString().slice(0, 10);
          const row = byDate.get(date);
          return {
            date,
            confirmedOrders: number(row?.confirmedOrders ?? 0n),
            revenueMinor: number(row?.revenueMinor ?? 0n),
          };
        });
        const total = number(summary.total);
        return {
          currency: 'EUR' as const,
          from,
          to,
          asOf: clock.now.toISOString(),
          lastUpdatedAt: summary.updatedAt?.toISOString() ?? null,
          totals: metrics(summary),
          events: rows.map((row) => ({
            id: row.id,
            title: row.title,
            startsAt: row.startsAt.toISOString(),
            updatedAt: row.updatedAt?.toISOString() ?? null,
            ...metrics(row),
          })),
          series,
          total,
          page: query.page,
          pageSize: query.pageSize,
          pages: Math.ceil(total / query.pageSize),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
