import { Prisma } from '../generated/client';

export type StatisticsMetrics = {
  capacity: bigint;
  soldSeats: bigint;
  heldSeats: bigint;
  availableSeats: bigint;
  confirmedOrders: bigint;
  revenueMinor: bigint;
  paidMinor: bigint;
  refundedMinor: bigint;
};

type StatisticsScope = {
  organizationId: string;
  eventId: string | undefined;
  now: Date;
  start: Date;
  until: Date;
  page: number;
  pageSize: number;
};

export async function readStatistics(
  tx: Prisma.TransactionClient,
  { organizationId, eventId, now, start, until, page, pageSize }: StatisticsScope,
) {
  const base = Prisma.sql`
  WITH events AS (
    SELECT e.id, e.title, p.capacity, p."startsAt" FROM "EventDraft" e
    JOIN "PublicEvent" p ON p."eventId" = e.id
    WHERE e."organizationId" = ${organizationId}::uuid
      ${eventId ? Prisma.sql`AND e.id = ${eventId}::uuid` : Prisma.empty}
  ), orders AS (
    SELECT o.* FROM "SalesOrder" o JOIN events e ON e.id = o."eventId"
    WHERE o."organizationId" = ${organizationId}::uuid
  ), order_totals AS (
    SELECT "eventId",
      coalesce(sum("seatCount") FILTER (WHERE state = 'CONFIRMED'), 0)::bigint AS "soldSeats",
      coalesce(sum("seatCount") FILTER (WHERE state = 'HELD' AND "expiresAt" > ${now}), 0)::bigint AS "heldSeats",
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
    (StatisticsMetrics & { total: bigint; updatedAt: Date | null })[]
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
    (StatisticsMetrics & { id: string; title: string; startsAt: Date; updatedAt: Date | null })[]
  >`${base}
  SELECT * FROM metrics ORDER BY "startsAt" DESC, id
  LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  const daily = await tx.$queryRaw<
    { date: string; confirmedOrders: bigint; revenueMinor: bigint }[]
  >`${base}
  SELECT to_char("confirmedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
    count(*) AS "confirmedOrders", sum("totalMinor")::bigint AS "revenueMinor"
  FROM orders WHERE state IN ('CONFIRMED','REFUNDED') AND "confirmedAt" >= ${start} AND "confirmedAt" < ${until}
  GROUP BY date ORDER BY date`;
  return { summary, rows, daily };
}
