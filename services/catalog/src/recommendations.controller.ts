import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parseInput, TokenVerifier } from '@eventflow/service-runtime';
import {
  MAX_RECOMMENDATION_FAVORITES,
  MAX_RECOMMENDATION_HYDRATION_IDS,
  MAX_RECOMMENDATIONS_PAGE_SIZE,
  MAX_SEAT_PRICE_MINOR,
  RECOMMENDATIONS_DEFAULT_PAGE_SIZE,
  searchDocumentSchema,
  type SearchDocument,
} from '@eventflow/event-contracts';
import { Database } from './database';
import { Prisma } from './generated/client';

const upcomingSchema = z
  .strictObject({
    city: z.string().trim().max(100).default(''),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    minPriceMinor: z.number().int().min(0).max(MAX_SEAT_PRICE_MINOR).optional(),
    maxPriceMinor: z.number().int().min(0).max(MAX_SEAT_PRICE_MINOR).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_RECOMMENDATIONS_PAGE_SIZE)
      .default(RECOMMENDATIONS_DEFAULT_PAGE_SIZE),
    exclude: z
      .array(z.uuid())
      .max(MAX_RECOMMENDATION_FAVORITES + 1)
      .default([]),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to)
  .refine(
    (v) =>
      v.minPriceMinor === undefined ||
      v.maxPriceMinor === undefined ||
      v.minPriceMinor <= v.maxPriceMinor,
  );

@Controller('internal/recommendations')
export class RecommendationCatalog {
  constructor(
    @Inject(TokenVerifier) private readonly tokens: TokenVerifier,
    @Inject(Database) private readonly db: Database,
  ) {}
  @Post('hydrate')
  @HttpCode(200)
  async hydrate(@Req() request: Request, @Body() body: unknown) {
    await this.tokens.service(
      request.header('authorization'),
      'eventflow-recommendations',
      'recommendations-index',
    );
    const { ids } = parseInput(
      z.strictObject({
        ids: z
          .array(z.uuid())
          .max(MAX_RECOMMENDATION_HYDRATION_IDS)
          .refine((value) => new Set(value).size === value.length),
      }),
      body,
    );
    if (!ids.length) return { events: [] };
    return this.read(Prisma.sql`p."eventId"=ANY(${ids}::uuid[])`, ids.length);
  }
  @Post('upcoming')
  @HttpCode(200)
  async upcoming(@Req() request: Request, @Body() body: unknown) {
    await this.tokens.service(
      request.header('authorization'),
      'eventflow-recommendations',
      'recommendations-index',
    );
    const query = parseInput(upcomingSchema, body);
    return this.read(
      Prisma.sql`
      p."eventId"<>ALL(${query.exclude}::uuid[])
      ${query.city ? Prisma.sql`AND lower(p.city)=lower(${query.city})` : Prisma.empty}
      ${query.from ? Prisma.sql`AND p."localDate">=${query.from}` : Prisma.empty}
      ${query.to ? Prisma.sql`AND p."localDate"<=${query.to}` : Prisma.empty}
      ${query.minPriceMinor !== undefined ? Prisma.sql`AND p."minPriceMinor">=${query.minPriceMinor}` : Prisma.empty}
      ${query.maxPriceMinor !== undefined ? Prisma.sql`AND p."minPriceMinor"<=${query.maxPriceMinor}` : Prisma.empty}
    `,
      query.limit,
    );
  }
  private async read(where: Prisma.Sql, limit: number) {
    const rows = await this.db.$queryRaw<
      (Omit<SearchDocument, 'startsAt' | 'endsAt'> & { startsAt: Date; endsAt: Date })[]
    >`
      SELECT p."eventId" AS id,e.title,e.description,e."coverId",p.city,p.address,p."timeZone",
        p."startsAt",p."endsAt",p."localDate",p."minPriceMinor",p.currency,p.capacity
      FROM "PublicEvent" p JOIN "EventDraft" e ON e.id=p."eventId"
      JOIN "Publication" publication ON publication."eventId"=p."eventId"
      WHERE ${where} AND p."startsAt">statement_timestamp()
        AND publication.state='PUBLISHED'
        AND NOT publication."desiredPaused" AND NOT publication."acknowledgedPaused"
      ORDER BY p."startsAt",p."eventId" LIMIT ${limit}
    `;
    return {
      events: rows.map((row) =>
        searchDocumentSchema.parse({
          ...row,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
        }),
      ),
    };
  }
}
