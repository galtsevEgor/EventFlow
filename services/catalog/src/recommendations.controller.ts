import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { searchDocumentSchema, type SearchDocument } from '@eventflow/event-contracts';
import { Database } from './database';

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
          .max(100)
          .refine((value) => new Set(value).size === value.length),
      }),
      body,
    );
    if (!ids.length) return { events: [] };
    const rows = await this.db.$queryRaw<
      (Omit<SearchDocument, 'startsAt' | 'endsAt'> & { startsAt: Date; endsAt: Date })[]
    >`
      SELECT p."eventId" AS id,e.title,e.description,e."coverId",p.city,p.address,p."timeZone",
        p."startsAt",p."endsAt",p."localDate",p."minPriceMinor",p.currency,p.capacity
      FROM "PublicEvent" p JOIN "EventDraft" e ON e.id=p."eventId"
      JOIN "Publication" publication ON publication."eventId"=p."eventId"
      WHERE p."eventId"=ANY(${ids}::uuid[]) AND p."startsAt">statement_timestamp()
        AND publication.state='PUBLISHED'
        AND NOT publication."desiredPaused" AND NOT publication."acknowledgedPaused"
      ORDER BY p."eventId"
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
