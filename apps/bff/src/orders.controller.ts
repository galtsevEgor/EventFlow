import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import { z } from 'zod';
import { AnalyticsBridge } from './analytics/service';
import { AuthService } from './auth/auth.service';
import { upstreamUrl } from './upstream-url';

@Controller('api/v1/orders')
export class OrdersController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AnalyticsBridge) private readonly analytics: AnalyticsBridge,
  ) {}
  @All(['', '{*path}'])
  async forward(@Req() request: Request, @Res() response: Response) {
    const path = request.path;
    const ticketCredential =
      request.method === 'GET' &&
      /^\/api\/v1\/orders\/[a-f0-9-]{36}\/tickets\/[a-f0-9-]{36}\/(qr|code)$/.test(path);
    const qr = ticketCredential && path.endsWith('/qr');
    const tickets =
      ticketCredential ||
      (request.method === 'GET' && /^\/api\/v1\/orders\/[a-f0-9-]{36}\/tickets$/.test(path));
    const payment =
      (request.method === 'GET' &&
        /^\/api\/v1\/orders\/[a-f0-9-]{36}\/payment-status$/.test(path)) ||
      (request.method === 'POST' &&
        /^\/api\/v1\/orders\/[a-f0-9-]{36}\/payment-attempt(?:\/fake-confirm)?$/.test(path));
    const allowed =
      tickets ||
      payment ||
      (request.method === 'GET'
        ? /^\/api\/v1\/orders(?:\/[a-f0-9-]{36})?$/.test(path)
        : request.method === 'POST' &&
          /^\/api\/v1\/orders(?:\/[a-f0-9-]{36}\/cancel)?$/.test(path));
    if (!allowed) throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    const { session } = await this.auth.requireSession(request);
    if (request.method !== 'GET') this.auth.assertCsrf(request, session.csrf);
    await this.auth.store.rateLimit(`orders:${session.user.sub}`, 120);
    if (request.method === 'POST' && path === '/api/v1/orders') {
      const { saleId } = parseInput(z.object({ saleId: z.uuid() }), request.body);
      await this.requirePublished(saleId, response);
    }
    let upstream: globalThis.Response;
    let body: unknown;
    const service = tickets ? 'TICKETS' : payment ? 'PAYMENTS' : 'BOOKING';
    try {
      const url = upstreamUrl(this.auth.config[`${service}_URL`], path, request.originalUrl);
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
          ...(this.analytics.enabled && this.analytics.session.read(request)
            ? { 'x-analytics-session': this.analytics.session.read(request)!.id }
            : {}),
        },
        ...(request.method === 'GET' || request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
      });
      if (upstream.status >= 500) {
        await upstream.body?.cancel();
        throw this.unavailable(service);
      }
      if (qr && upstream.ok) {
        if (upstream.status !== 200 || upstream.headers.get('content-type') !== 'image/png') {
          await upstream.body?.cancel();
          throw this.unavailable(service);
        }
        const png = Buffer.from(await upstream.arrayBuffer());
        response.setHeader('cache-control', 'no-store');
        response.setHeader('content-type', 'image/png');
        response.setHeader('cross-origin-resource-policy', 'same-origin');
        response.status(200).end(png);
        return;
      }
      body = await upstream.json();
    } catch {
      throw this.unavailable(service);
    }
    response.setHeader('cache-control', 'no-store');
    response.status(upstream.status).json(body);
  }
  private unavailable(service: 'BOOKING' | 'PAYMENTS' | 'TICKETS') {
    const messages = {
      BOOKING: 'Бронирование временно недоступно. Повторите тот же запрос.',
      PAYMENTS: 'Проверяем состояние платежа. Не оплачивайте повторно.',
      TICKETS: 'Билеты временно недоступны. Попробуйте ещё раз.',
    };
    return new ApiError(503, `${service}_UNAVAILABLE`, messages[service]);
  }
  private async requirePublished(id: string, response: Response) {
    let status: number;
    try {
      const result = await fetch(new URL(`/api/v1/events/${id}`, this.auth.config.CATALOG_URL), {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          'x-request-id': response.locals.requestId,
          traceparent: response.locals.traceparent,
        },
      });
      status = result.status;
      await result.body?.cancel();
    } catch {
      throw new ApiError(
        503,
        'CATALOG_UNAVAILABLE',
        'Не удалось проверить публикацию. Повторите тот же запрос.',
      );
    }
    if (status === 404) throw new ApiError(404, 'NOT_FOUND', 'Мероприятие ещё не опубликовано.');
    if (status !== 200)
      throw new ApiError(
        503,
        'CATALOG_UNAVAILABLE',
        'Не удалось проверить публикацию. Повторите тот же запрос.',
      );
  }
}
