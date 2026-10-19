import { Controller, Get, Inject, Query } from '@nestjs/common';
import { parseInput } from '@eventflow/service-runtime';
import { searchPageSchema, searchQuerySchema } from '@eventflow/event-contracts';
import { Database } from '../database';
import { Prisma } from '../generated/client';

type EventRow = {
  id: string;
  title: string;
  description: string;
  city: string;
  address: string;
  timeZone: string;
  startsAt: Date;
  endsAt: Date;
  localDate: string;
  minPriceMinor: number;
  currency: 'EUR';
  capacity: number;
  coverId: string | null;
};
function literal(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

export class SearchFallback {
  constructor(private readonly db: Database) {}
  async list(input: unknown) {
    const query = parseInput(searchQuerySchema, input);
    const { q, city, from, to, minPriceMinor, maxPriceMinor, page, pageSize } = query;
    const base = Prisma.sql`FROM "PublicEvent" p
      JOIN "EventDraft" e ON e.id = p."eventId"
      JOIN "Publication" publication ON publication."eventId" = p."eventId" AND publication.state = 'PUBLISHED'
      WHERE p."endsAt" > transaction_timestamp()
        ${q ? Prisma.sql`AND (e.title ILIKE ${'%' + literal(q) + '%'} OR e.description ILIKE ${'%' + literal(q) + '%'})` : Prisma.empty}
        ${from ? Prisma.sql`AND p."localDate" >= ${from}::char(10)` : Prisma.empty}
        ${to ? Prisma.sql`AND p."localDate" <= ${to}::char(10)` : Prisma.empty}
        ${minPriceMinor !== undefined ? Prisma.sql`AND p."minPriceMinor" >= ${minPriceMinor}` : Prisma.empty}
        ${maxPriceMinor !== undefined ? Prisma.sql`AND p."minPriceMinor" <= ${maxPriceMinor}` : Prisma.empty}`;
    const selected = city ? Prisma.sql`AND p.city ILIKE ${literal(city)}` : Prisma.empty;
    const order =
      query.sort === 'price_asc'
        ? Prisma.sql`p."minPriceMinor", p."startsAt", p."eventId"`
        : query.sort === 'price_desc'
          ? Prisma.sql`p."minPriceMinor" DESC, p."startsAt", p."eventId"`
          : Prisma.sql`p."startsAt", p."eventId"`;
    return this.db.$transaction(
      async (tx) => {
        const [count] = await tx.$queryRaw<
          { total: bigint; min: number | null; max: number | null }[]
        >`
        SELECT count(*) AS total, min(p."minPriceMinor") AS min, max(p."minPriceMinor") AS max ${base} ${selected}`;
        const cities = await tx.$queryRaw<{ value: string; count: bigint }[]>`
        SELECT p.city AS value, count(*) AS count ${base} GROUP BY p.city ORDER BY count DESC, p.city LIMIT 30`;
        const events = await tx.$queryRaw<EventRow[]>`
        SELECT p."eventId" AS id, e.title, e.description, p.city, p.address, p."timeZone",
          p."startsAt", p."endsAt", p."localDate", p."minPriceMinor", p.currency, p.capacity, e."coverId"
        ${base} ${selected} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
        const total = Number(count!.total);
        return searchPageSchema.parse({
          events: events.map((event) => ({
            ...event,
            startsAt: event.startsAt.toISOString(),
            endsAt: event.endsAt.toISOString(),
          })),
          total,
          page,
          pageSize,
          pages: Math.min(200, Math.ceil(total / pageSize)),
          facets: {
            cities: cities.map((row) => ({ value: row.value, count: Number(row.count) })),
            price: { min: count!.min, max: count!.max },
          },
          source: 'catalog',
          limited: true,
        });
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}

@Controller('api/v1/search')
export class SearchFallbackController {
  constructor(@Inject(SearchFallback) private readonly search: SearchFallback) {}
  @Get('fallback') list(@Query() input: unknown) {
    return this.search.list(input);
  }
}
