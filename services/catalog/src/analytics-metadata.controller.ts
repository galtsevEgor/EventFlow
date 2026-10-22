import { Body, Controller, Inject, Post, Headers, HttpCode } from '@nestjs/common';
import { TokenVerifier, parseInput } from '@eventflow/service-runtime';
import { z } from 'zod';
import { Database } from './database';

@Controller('internal/analytics')
export class AnalyticsMetadata {
  constructor(
    @Inject(TokenVerifier) private readonly tokens: TokenVerifier,
    @Inject(Database) private readonly db: Database,
  ) {}
  @Post('events')
  @HttpCode(200)
  async events(@Headers('authorization') auth: string | undefined, @Body() input: unknown) {
    await this.tokens.service(auth, 'eventflow-analytics', 'analytics-ingest');
    const { ids } = parseInput(z.strictObject({ ids: z.array(z.uuid()).min(1).max(30) }), input);
    const events = await this.db.publicEvent.findMany({
      where: { eventId: { in: ids } },
      select: { eventId: true, event: { select: { organizationId: true } } },
    });
    return {
      events: events.map((row) => ({ id: row.eventId, organizationId: row.event.organizationId })),
    };
  }
}
