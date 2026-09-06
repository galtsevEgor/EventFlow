import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '@eventflow/service-runtime';
import { AuthService } from './auth/auth.service';

@Controller('api/v1/orders')
export class OrdersController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @All(['', '{*path}'])
  async forward(@Req() request: Request, @Res() response: Response) {
    const path = request.path;
    const allowed =
      request.method === 'GET'
        ? /^\/api\/v1\/orders(?:\/[a-f0-9-]{36})?$/.test(path)
        : request.method === 'POST' && /^\/api\/v1\/orders(?:\/[a-f0-9-]{36}\/cancel)?$/.test(path);
    if (!allowed) throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    const { session } = await this.auth.requireSession(request);
    if (request.method !== 'GET') this.auth.assertCsrf(request, session.csrf);
    await this.auth.store.rateLimit(`orders:${session.user.sub}`, 120);
    let upstream: globalThis.Response;
    try {
      const url = new URL(request.originalUrl, this.auth.config.BOOKING_URL);
      const key = request.header('idempotency-key');
      upstream = await fetch(url, {
        method: request.method,
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          'x-request-id': response.locals.requestId,
          traceparent: response.locals.traceparent,
          ...(key ? { 'idempotency-key': key } : {}),
        },
        ...(request.method === 'GET' || request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
      });
    } catch {
      throw new ApiError(
        503,
        'BOOKING_UNAVAILABLE',
        'Бронирование временно недоступно. Повторите тот же запрос.',
      );
    }
    if (upstream.status >= 500)
      throw new ApiError(
        503,
        'BOOKING_UNAVAILABLE',
        'Бронирование временно недоступно. Повторите тот же запрос.',
      );
    response.setHeader('cache-control', 'no-store');
    response.status(upstream.status).json(await upstream.json());
  }
}
