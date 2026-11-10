import { All, Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import { analyticsBatchSchema } from '@eventflow/event-contracts';
import { AuthService } from '../auth/auth.service';
import { upstreamUrl } from '../upstream-url';
import { AnalyticsBridge } from './service';

const ANALYTICS_EVENTS_RATE_LIMIT = 120;
const ANALYTICS_REPORT_RATE_LIMIT = 60;
const ANALYTICS_REPORT_TIMEOUT_MS = 18_000;

@Controller()
export class AnalyticsProxy {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AnalyticsBridge) private readonly analytics: AnalyticsBridge,
  ) {}
  @Get('api/v1/analytics/context')
  context(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('cache-control', 'no-store');
    return this.analytics.context(request, response);
  }
  @Post('api/v1/analytics/events')
  @HttpCode(202)
  async events(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() input: unknown,
  ) {
    if (request.header('origin') !== this.auth.config.PUBLIC_ORIGIN)
      throw new ApiError(403, 'FORBIDDEN', 'Неверный источник запроса.');
    const session = this.analytics.session.read(request);
    if (!session) throw new ApiError(409, 'ANALYTICS_SESSION', 'Обновите контекст аналитики.');
    const { events } = parseInput(analyticsBatchSchema, input);
    await this.auth.store.rateLimit('analytics:' + session.id, ANALYTICS_EVENTS_RATE_LIMIT);
    const searchIds: Record<string, string> = {};
    for (const event of events) {
      if (event.source === 'search' || event.kind === 'search_click') {
        const id = this.analytics.searchId(event.searchProof, event.eventId);
        if (!id) throw new ApiError(422, 'ANALYTICS_PROOF', 'Неверное поисковое событие.');
        searchIds[event.id] = id;
      }
    }
    response.setHeader('cache-control', 'no-store');
    return this.analytics.send('events', { sessionId: session.id, events, searchIds });
  }
  @All([
    'api/v1/organizations/:id/analytics',
    'api/v1/organizations/:id/analytics/waitlist',
    'api/v1/analytics/search-quality',
  ])
  async report(@Req() request: Request, @Res() response: Response) {
    if (request.method !== 'GET') throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    const { session } = await this.auth.requireSession(request);
    await this.auth.store.rateLimit(
      'analytics-report:' + session.user.sub,
      ANALYTICS_REPORT_RATE_LIMIT,
    );
    try {
      const url = upstreamUrl(this.auth.config.ANALYTICS_URL, request.path, request.originalUrl);
      const result = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(ANALYTICS_REPORT_TIMEOUT_MS),
        headers: { authorization: 'Bearer ' + session.accessToken },
      });
      const body = await result.json();
      response.setHeader('cache-control', 'no-store');
      response.status(result.status).json(body);
    } catch {
      throw new ApiError(503, 'ANALYTICS_UNAVAILABLE', 'Аналитика временно недоступна.');
    }
  }
}
