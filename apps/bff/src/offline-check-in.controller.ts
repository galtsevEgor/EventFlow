import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '@eventflow/service-runtime';
import { AuthService } from './auth/auth.service';
import { upstreamUrl } from './upstream-url';

const OFFLINE_GATE_RATE_LIMIT = 120;
const OFFLINE_GATE_TIMEOUT_MS = 20_000;

@Controller('api/v1/offline-check-in')
export class OfflineCheckInProxy {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @All(['keys', 'sessions', 'sync'])
  async forward(@Req() request: Request, @Res() response: Response) {
    const allowed =
      (request.method === 'GET' && request.path === '/api/v1/offline-check-in/keys') ||
      (request.method === 'POST' &&
        ['/api/v1/offline-check-in/sessions', '/api/v1/offline-check-in/sync'].includes(
          request.path,
        ));
    if (!allowed) throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    const { session } = await this.auth.requireSession(request);
    if (!session.user.emailVerified)
      throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
    if (request.method !== 'GET') this.auth.assertCsrf(request, session.csrf);
    await this.auth.store.rateLimit('offline-gate:' + session.user.sub, OFFLINE_GATE_RATE_LIMIT);
    response.setHeader('cache-control', 'no-store');
    try {
      const result = await fetch(
        upstreamUrl(this.auth.config.TICKETS_URL, request.path, request.originalUrl),
        {
          method: request.method,
          redirect: 'error',
          signal: AbortSignal.timeout(OFFLINE_GATE_TIMEOUT_MS),
          headers: {
            authorization: 'Bearer ' + session.accessToken,
            'content-type': 'application/json',
            'x-request-id': response.locals.requestId,
            traceparent: response.locals.traceparent,
          },
          ...(request.method === 'GET' ? {} : { body: JSON.stringify(request.body ?? {}) }),
        },
      );
      if (result.status >= 500) {
        await result.body?.cancel();
        throw new Error('Offline gate unavailable');
      }
      response.status(result.status).json(await result.json());
    } catch {
      throw new ApiError(
        503,
        'OFFLINE_GATE_UNAVAILABLE',
        'Синхронизация недоступна. Сохранённые проверки остаются в очереди.',
      );
    }
  }
}
