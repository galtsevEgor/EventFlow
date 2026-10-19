import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import { searchQuerySchema } from '@eventflow/event-contracts';
import { SearchService } from './search.service';

@Controller('api/v1/search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}
  @Get('events') async list(
    @Query() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.read(input, response);
  }
  @Get('suggest') async suggest(
    @Query() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const page = await this.read(input, response, true);
    return {
      suggestions: page.events.map(({ id, title, city }) => ({ id, title, city })),
      limited: false,
    };
  }
  private async read(input: unknown, response: Response, suggest = false) {
    const query = parseInput(searchQuerySchema, input);
    response.setHeader('cache-control', 'no-store');
    try {
      return await this.search.list(query, suggest);
    } catch {
      throw new ApiError(503, 'SEARCH_UNAVAILABLE', 'Поиск временно недоступен. Повторите позже.');
    }
  }
}
