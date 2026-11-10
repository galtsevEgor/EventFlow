import { Controller, Get, Inject, Query } from '@nestjs/common';
import { parseInput } from '@eventflow/service-runtime';
import {
  MAX_SEARCH_CITY_FACETS,
  MAX_SEARCH_PAGE,
  type SearchDocument,
  searchPageSchema,
  searchQuerySchema,
} from '@eventflow/event-contracts';
import { Database } from '../database';
import { Prisma } from '../generated/client';

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
    // One statement gives counts, facets and page the same snapshot and evaluates text once.
    const [row] = await this.db.$queryRaw<
      {
        total: bigint;
        min: number | null;
        max: number | null;
        cities: { value: string; count: number }[];
        events: SearchDocument[];
      }[]
    >`
      WITH eligible AS MATERIALIZED (
        SELECT p."eventId", p.city, p."startsAt", p."minPriceMinor" ${base}
      ), selected AS MATERIALIZED (
        SELECT * FROM eligible p WHERE true ${selected}
      ), counts AS (
        SELECT count(*) AS total, min("minPriceMinor") AS min, max("minPriceMinor") AS max FROM selected
      ), cities AS (
        SELECT city AS value, count(*) AS count FROM eligible GROUP BY city
        ORDER BY count DESC, city LIMIT ${MAX_SEARCH_CITY_FACETS}
      ), page AS (
        SELECT p.*, row_number() OVER (ORDER BY ${order}) AS rank
        FROM selected p ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      )
      SELECT counts.*,
        coalesce((SELECT jsonb_agg(to_jsonb(cities) ORDER BY count DESC, value) FROM cities), '[]'::jsonb) AS cities,
        coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'id', p."eventId", 'title', e.title, 'description', e.description, 'city', p.city,
            'address', public.address, 'timeZone', public."timeZone", 'startsAt', public."startsAt",
            'endsAt', public."endsAt", 'localDate', public."localDate", 'minPriceMinor', p."minPriceMinor",
            'currency', public.currency, 'capacity', public.capacity, 'coverId', e."coverId"
          ) ORDER BY p.rank)
          FROM page p JOIN "PublicEvent" public ON public."eventId" = p."eventId"
          JOIN "EventDraft" e ON e.id = p."eventId"
        ), '[]'::jsonb) AS events
      FROM counts`;
    const total = Number(row!.total);
    return searchPageSchema.parse({
      events: row!.events.map((event) => ({
        ...event,
        startsAt: new Date(event.startsAt).toISOString(),
        endsAt: new Date(event.endsAt).toISOString(),
      })),
      total,
      page,
      pageSize,
      pages: Math.min(MAX_SEARCH_PAGE, Math.ceil(total / pageSize)),
      facets: { cities: row!.cities, price: { min: row!.min, max: row!.max } },
      source: 'catalog',
      limited: true,
    });
  }
}

@Controller('api/v1/search')
export class SearchFallbackController {
  constructor(@Inject(SearchFallback) private readonly search: SearchFallback) {}
  @Get('fallback') list(@Query() input: unknown) {
    return this.search.list(input);
  }
}
