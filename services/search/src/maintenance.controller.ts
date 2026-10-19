import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { RebuildIndex } from './rebuild';
import { ProjectionBusy } from './lease';

@Controller('internal/search')
export class SearchMaintenance {
  constructor(
    @Inject(TokenVerifier) private readonly tokens: TokenVerifier,
    @Inject(RebuildIndex) private readonly rebuild: RebuildIndex,
  ) {}
  @Post('reindex') @HttpCode(200) async reindex(@Req() request: Request, @Body() body: unknown) {
    await this.tokens.service(request.header('authorization'), 'eventflow-search', 'search-index');
    parseInput(z.strictObject({}), body);
    try {
      return await this.rebuild.run();
    } catch (error) {
      if (error instanceof ProjectionBusy)
        throw new ApiError(409, 'SEARCH_BUSY', 'Перестроение уже выполняется. Повторите позже.');
      throw new ApiError(
        503,
        'SEARCH_REBUILD_FAILED',
        'Перестроение не завершено. Повторите позже.',
      );
    }
  }
}
