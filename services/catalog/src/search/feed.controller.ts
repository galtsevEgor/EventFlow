import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { MAX_SEARCH_RECONCILE_BATCH_SIZE, searchFeedQuerySchema } from '@eventflow/event-contracts';
import { SearchFeed } from './feed.service';
@Controller('internal/search')
export class SearchFeedController {
  constructor(
    @Inject(TokenVerifier) private readonly tokens: TokenVerifier,
    @Inject(SearchFeed) private readonly feed: SearchFeed,
  ) {}
  private async authorize(request: Request) {
    try {
      await this.tokens.service(
        request.header('authorization'),
        'eventflow-search',
        'search-index',
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.getStatus() !== 403) throw error;
      await this.tokens.service(
        request.header('authorization'),
        'eventflow-recommendations',
        'recommendations-index',
      );
    }
  }
  @Get('changes') async changes(@Req() request: Request, @Query() query: unknown) {
    await this.authorize(request);
    return this.feed.read(parseInput(searchFeedQuerySchema, query));
  }
  @Post('reconcile') @HttpCode(200) async reconcile(
    @Req() request: Request,
    @Body() body: unknown,
  ) {
    await this.authorize(request);
    const query = parseInput(
      z.strictObject({
        after: z.uuid().optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_RECONCILE_BATCH_SIZE)
          .default(MAX_SEARCH_RECONCILE_BATCH_SIZE),
      }),
      body,
    );
    return this.feed.reconcile(query.after, query.limit);
  }
}
