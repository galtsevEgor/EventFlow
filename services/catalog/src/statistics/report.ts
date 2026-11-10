import { z } from 'zod';
import { EVENT_CURRENCY } from '@eventflow/event-contracts';
import { ApiError, parseInput, type UserIdentity } from '@eventflow/service-runtime';
import { Database } from '../database';
import { requireMembership } from '../organizations/access';
import { readStatistics, type StatisticsMetrics } from './report-query';

const UTC_DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_STATISTICS_DAYS = 30;
const MAX_STATISTICS_DAYS = 366;
const MAX_STATISTICS_PAGE = 1_000;
const MAX_STATISTICS_PAGE_SIZE = 50;
const DEFAULT_STATISTICS_PAGE_SIZE = 20;

const querySchema = z.strictObject({
  eventId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).max(MAX_STATISTICS_PAGE).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_STATISTICS_PAGE_SIZE)
    .default(DEFAULT_STATISTICS_PAGE_SIZE),
});
type StatisticsQuery = z.infer<typeof querySchema>;

function safeNumber(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new ApiError(503, 'STATISTICS_TOO_LARGE', 'Сузьте период или выберите мероприятие.');
  return result;
}
function metrics(row: StatisticsMetrics) {
  return {
    capacity: safeNumber(row.capacity),
    soldSeats: safeNumber(row.soldSeats),
    heldSeats: safeNumber(row.heldSeats),
    availableSeats: safeNumber(row.availableSeats),
    confirmedOrders: safeNumber(row.confirmedOrders),
    revenueMinor: safeNumber(row.revenueMinor),
    paidMinor: safeNumber(row.paidMinor),
    refundedMinor: safeNumber(row.refundedMinor),
    netMinor: safeNumber(row.paidMinor - row.refundedMinor),
  };
}

function reportPeriod(query: StatisticsQuery, now: Date) {
  const to = query.to ?? now.toISOString().slice(0, 10);
  const from =
    query.from ??
    new Date(+new Date(to) - (DEFAULT_STATISTICS_DAYS - 1) * UTC_DAY_MS).toISOString().slice(0, 10);
  const start = new Date(from + 'T00:00:00Z');
  const until = new Date(+new Date(to + 'T00:00:00Z') + UTC_DAY_MS);
  const days = (+until - +start) / UTC_DAY_MS;
  if (!Number.isFinite(days) || days < 1 || days > MAX_STATISTICS_DAYS)
    throw new ApiError(
      422,
      'INVALID_INPUT',
      `Выберите период от 1 до ${MAX_STATISTICS_DAYS} дней.`,
    );

  return { from, to, start, until, days };
}

function reportResponse(
  query: StatisticsQuery,
  { from, to, start, days }: ReturnType<typeof reportPeriod>,
  now: Date,
  { summary, rows, daily }: Awaited<ReturnType<typeof readStatistics>>,
) {
  const byDate = new Map(daily.map((row) => [row.date, row]));
  const series = Array.from({ length: days }, (_, i) => {
    const date = new Date(+start + i * UTC_DAY_MS).toISOString().slice(0, 10);
    const row = byDate.get(date);
    return {
      date,
      confirmedOrders: safeNumber(row?.confirmedOrders ?? 0n),
      revenueMinor: safeNumber(row?.revenueMinor ?? 0n),
    };
  });
  const total = safeNumber(summary.total);
  return {
    currency: EVENT_CURRENCY,
    from,
    to,
    asOf: now.toISOString(),
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
        const period = reportPeriod(query, clock.now);
        const data = await readStatistics(tx, {
          organizationId,
          eventId: query.eventId,
          now: clock.now,
          start: period.start,
          until: period.until,
          page: query.page,
          pageSize: query.pageSize,
        });
        return reportResponse(query, period, clock.now, data);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
