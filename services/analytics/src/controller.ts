import {
  Body,
  Controller,
  Get,
  Post,
  HttpCode,
  Headers,
  Param,
  Query,
  Inject,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  ApiError,
  ClientCredentials,
  TokenVerifier,
  parseInput,
  requirePolicy,
} from '@eventflow/service-runtime';
import { analyticsPeriodSchema } from '@eventflow/event-contracts';
import { AnalyticsIngest } from './ingest';
import { AnalyticsReport } from './report';
import { AnalyticsProjection } from './projection';
import type { AnalyticsConfig } from './config';
import { WaitlistReport } from './waitlist-report';
export const ANALYTICS_CONFIG = Symbol('ANALYTICS_CONFIG');
@Controller()
export class AnalyticsController {
  constructor(
    @Inject(TokenVerifier) private readonly tokens: TokenVerifier,
    @Inject(ClientCredentials) private readonly policy: ClientCredentials,
    @Inject(ANALYTICS_CONFIG) private readonly config: AnalyticsConfig,
    @Inject(AnalyticsIngest) private readonly ingest: AnalyticsIngest,
    @Inject(AnalyticsReport) private readonly report: AnalyticsReport,
    @Inject(AnalyticsProjection) private readonly projection: AnalyticsProjection,
    @Inject(WaitlistReport) private readonly waitlist: WaitlistReport,
  ) {}
  @Post('internal/analytics/events')
  @HttpCode(202)
  async events(@Headers('authorization') auth: string | undefined, @Body() input: unknown) {
    await this.tokens.service(auth, 'eventflow-analytics', 'analytics-ingest');
    return this.ingest.browser(input);
  }
  @Post('internal/analytics/search')
  @HttpCode(202)
  async searchFact(@Headers('authorization') auth: string | undefined, @Body() input: unknown) {
    await this.tokens.service(auth, 'eventflow-analytics', 'analytics-ingest');
    return this.ingest.search(input);
  }
  @Get('api/v1/organizations/:id/analytics')
  async read(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
    @Query() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = await this.tokens.user(auth),
      organizationId = parseInput(z.uuid(), id),
      query = parseInput(analyticsPeriodSchema, input);
    await requirePolicy(this.config.CATALOG_URL, await this.policy.token(), {
      actorSubject: user.subject,
      organizationId,
      action: 'events:write',
    });
    response.setHeader('cache-control', 'no-store');
    try {
      return await this.report.read(organizationId, query);
    } catch {
      throw new ApiError(
        503,
        'ANALYTICS_UNAVAILABLE',
        'Аналитика обновляется или временно недоступна. Повторите позже.',
      );
    }
  }
  @Get('api/v1/organizations/:id/analytics/waitlist')
  async waitlistReport(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
    @Query() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = await this.tokens.user(auth),
      organizationId = parseInput(z.uuid(), id),
      query = parseInput(
        analyticsPeriodSchema.refine(
          (q) => q.source === undefined,
          'У листа ожидания нет браузерного источника.',
        ),
        input,
      );
    await requirePolicy(this.config.CATALOG_URL, await this.policy.token(), {
      actorSubject: user.subject,
      organizationId,
      action: 'events:write',
    });
    response.setHeader('cache-control', 'no-store');
    try {
      return await this.waitlist.read(organizationId, query);
    } catch {
      throw new ApiError(503, 'ANALYTICS_UNAVAILABLE', 'Аналитика временно недоступна.');
    }
  }
  @Get('api/v1/analytics/search-quality')
  async search(
    @Headers('authorization') auth: string | undefined,
    @Query() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.tokens.operator(auth);
    const query = parseInput(analyticsPeriodSchema, input);
    response.setHeader('cache-control', 'no-store');
    try {
      return await this.report.search(query);
    } catch {
      throw new ApiError(503, 'ANALYTICS_UNAVAILABLE', 'Аналитика временно недоступна.');
    }
  }
  @Post('internal/analytics/rebuild')
  @HttpCode(200)
  async rebuild(@Headers('authorization') auth: string | undefined) {
    await this.tokens.operator(auth, true);
    const result = await this.projection.rebuild();
    if (!result) throw new ApiError(409, 'ANALYTICS_BUSY', 'Пересчёт уже выполняется.');
    return result;
  }
}
