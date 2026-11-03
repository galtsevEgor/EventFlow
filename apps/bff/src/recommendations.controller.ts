import { All, Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import {
  recommendationPageSchema,
  recommendationProfileSchema,
  recommendationInterestsSchema,
} from '@eventflow/event-contracts';
import { AuthService } from './auth/auth.service';
import { upstreamUrl } from './upstream-url';

@Controller('api/v1')
export class RecommendationsProxy {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @All([
    'recommendations/interests',
    'recommendations/profile',
    'recommendations/me',
    'recommendations/favorites/:id',
  ])
  async personal(@Req() request: Request, @Res() response: Response) {
    response.setHeader('cache-control', 'no-store');
    const path = request.path;
    const metadata = path === '/api/v1/recommendations/interests' && request.method === 'GET';
    const profile =
      path === '/api/v1/recommendations/profile' && ['GET', 'PUT'].includes(request.method);
    const feed = path === '/api/v1/recommendations/me' && request.method === 'GET';
    const favorite =
      /^\/api\/v1\/recommendations\/favorites\/[a-f0-9-]{36}$/.test(path) &&
      ['PUT', 'DELETE'].includes(request.method);
    if (
      (!metadata && !profile && !feed && !favorite) ||
      this.auth.config.RECOMMENDATIONS_ENABLED !== 'true'
    )
      throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    let token: string | undefined;
    if (!metadata) {
      const { session } = await this.auth.requireSession(request);
      if (!session.user.emailVerified)
        throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
      if (request.method !== 'GET') this.auth.assertCsrf(request, session.csrf);
      await this.auth.store.rateLimit('recommendations:user:' + session.user.sub, 120);
      token = session.accessToken;
    } else await this.auth.store.rateLimit('recommendations:' + request.ip, 120);
    try {
      const result = await fetch(
        upstreamUrl(this.auth.config.RECOMMENDATIONS_URL, path, request.originalUrl),
        {
          method: request.method,
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
          headers: {
            'content-type': 'application/json',
            'x-request-id': response.locals.requestId,
            traceparent: response.locals.traceparent,
            ...(token ? { authorization: 'Bearer ' + token } : {}),
          },
          ...(request.method === 'PUT' && profile ? { body: JSON.stringify(request.body) } : {}),
        },
      );
      if (!result.ok) {
        const status = result.status;
        await result.body?.cancel();
        const messages: Record<number, [string, string]> = {
          401: ['UNAUTHENTICATED', 'Войдите в аккаунт.'],
          403: ['EMAIL_UNVERIFIED', 'Подтвердите email.'],
          404: ['NOT_FOUND', 'Мероприятие недоступно.'],
          409: profile
            ? ['PROFILE_CHANGED', 'Настройки изменились. Загрузите их заново.']
            : ['FAVORITES_LIMIT', 'Можно сохранить до 100 мероприятий.'],
          422: ['VALIDATION_FAILED', 'Проверьте параметры подборки.'],
        };
        const problem = messages[status];
        if (problem) throw new ApiError(status, problem[0], problem[1]);
        throw new Error('Recommendations unavailable');
      }
      const body: unknown = await result.json();
      if (metadata) response.json(recommendationInterestsSchema.parse(body));
      else if (feed) {
        const page = recommendationPageSchema.parse(body);
        if (page.mode === 'similar') throw new Error('Invalid personal recommendation mode');
        response.json(page);
      } else response.json(recommendationProfileSchema.parse(body));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'RECOMMENDATIONS_UNAVAILABLE', 'Подборка временно недоступна.');
    }
  }
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
