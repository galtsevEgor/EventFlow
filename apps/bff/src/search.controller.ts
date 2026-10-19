import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import { searchPageSchema, searchQuerySchema } from '@eventflow/event-contracts';
import { AuthService } from './auth/auth.service';

const suggestionsSchema = z.strictObject({
  suggestions: z
    .array(z.strictObject({ id: z.uuid(), title: z.string().max(160), city: z.string().max(100) }))
    .max(6),
  limited: z.boolean(),
});
@Controller('api/v1/search')
export class SearchProxy {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Get('events') async list(
    @Query() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.read(input, response, false);
  }
  @Get('suggest') async suggest(
    @Query() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.read(input, response, true);
  }
  private async read(input: unknown, response: Response, suggest: boolean) {
    const query = parseInput(searchQuerySchema, input);
    response.setHeader('cache-control', 'no-store');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    if (this.auth.config.SEARCH_ENABLED === 'true') {
      try {
        const url = new URL(
          '/api/v1/search/' + (suggest ? 'suggest' : 'events'),
          this.auth.config.SEARCH_URL,
        );
        url.search = params.toString();
        const result = await this.fetch(url, response);
        return suggest ? suggestionsSchema.parse(result) : searchPageSchema.parse(result);
      } catch {
        // Discovery can use the authoritative catalog while its projection recovers.
      }
    }
    try {
      const url = new URL('/api/v1/search/fallback', this.auth.config.CATALOG_URL);
      if (suggest) {
        params.set('page', '1');
        params.set('pageSize', '6');
      }
      url.search = params.toString();
      const page = searchPageSchema.parse(await this.fetch(url, response));
      return suggest
        ? {
            suggestions: page.events.map(({ id, title, city }) => ({ id, title, city })),
            limited: true,
          }
        : page;
    } catch {
      throw new ApiError(503, 'SEARCH_UNAVAILABLE', 'Поиск временно недоступен. Повторите позже.');
    }
  }
  private async fetch(url: URL, response: Response) {
    const result = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
      headers: {
        'x-request-id': response.locals.requestId,
        traceparent: response.locals.traceparent,
      },
    });
    if (!result.ok) {
      await result.body?.cancel();
      throw new Error('Search upstream unavailable');
    }
    return result.json();
  }
}
