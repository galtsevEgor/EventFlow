import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { searchFeedQuerySchema } from '@eventflow/event-contracts';
import { SearchFeed } from './feed.service';
@Controller('internal/search')
export class SearchFeedController {
  constructor(
    @Inject(TokenVerifier) private readonly tokens: TokenVerifier,
    @Inject(SearchFeed) private readonly feed: SearchFeed,
  ) {}
  @Get('changes') async changes(@Req() request: Request, @Query() query: unknown) {
    await this.tokens.service(request.header('authorization'), 'eventflow-search', 'search-index');
    return this.feed.read(parseInput(searchFeedQuerySchema, query));
  }
  @Post('reconcile') @HttpCode(200) async reconcile(
    @Req() request: Request,
    @Body() body: unknown,
  ) {
    await this.tokens.service(request.header('authorization'), 'eventflow-search', 'search-index');
    const query = parseInput(
      z.strictObject({
        after: z.uuid().optional(),
        limit: z.number().int().min(1).max(100).default(100),
      }),
      body,
    );
    return this.feed.reconcile(query.after, query.limit);
  }
}
