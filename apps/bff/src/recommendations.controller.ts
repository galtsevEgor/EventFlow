import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import { recommendationPageSchema } from '@eventflow/event-contracts';
import { AuthService } from './auth/auth.service';
import { upstreamUrl } from './upstream-url';

@Controller('api/v1')
export class RecommendationsProxy {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Get('events/:id/similar')
  async similar(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    response.setHeader('cache-control', 'no-store');
    if (this.auth.config.RECOMMENDATIONS_ENABLED !== 'true')
      throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    const eventId = parseInput(z.uuid(), id);
    await this.auth.store.rateLimit('recommendations:' + request.ip, 120);
    try {
      const result = await fetch(
        upstreamUrl(
          this.auth.config.RECOMMENDATIONS_URL,
          '/api/v1/events/' + eventId + '/similar',
          request.originalUrl,
        ),
        {
          redirect: 'error',
          signal: AbortSignal.timeout(2000),
          headers: {
            'x-request-id': response.locals.requestId,
            traceparent: response.locals.traceparent,
          },
        },
      );
      if (result.status === 404) {
        await result.body?.cancel();
        throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
      }
      if (result.status === 422) {
        await result.body?.cancel();
        throw new ApiError(422, 'VALIDATION_FAILED', 'Проверьте параметры подборки.');
      }
      if (!result.ok) {
        await result.body?.cancel();
        throw new Error('Recommendations unavailable');
      }
      const page = recommendationPageSchema.parse(await result.json());
      if (page.mode === 'personal') throw new Error('Invalid public recommendation mode');
      response.status(200).json(page);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'RECOMMENDATIONS_UNAVAILABLE', 'Подборка временно недоступна.');
    }
  }
}
