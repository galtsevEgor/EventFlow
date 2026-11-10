import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import { z } from 'zod';
import { AnalyticsBridge } from './analytics/service';
import { AuthService } from './auth/auth.service';
import { requireProxySession } from './auth/proxy-session';
import { orderRoute, type OrderUpstream } from './orders.routes';
import { upstreamUrl } from './upstream-url';

const ORDERS_API_RATE = { scope: 'orders', limit: 120 };
const ORDER_PROXY_TIMEOUT_MS = 12_000;
const ORDER_PUBLICATION_CHECK_TIMEOUT_MS = 5_000;

@Controller('api/v1/orders')
export class OrdersController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AnalyticsBridge) private readonly analytics: AnalyticsBridge,
  ) {}
  @All(['', '{*path}'])
  async forward(@Req() request: Request, @Res() response: Response) {
    const path = request.path;
    const route = orderRoute(request.method, path);
    if (!route) throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    const session = await requireProxySession(this.auth, request, ORDERS_API_RATE);
    if (route.reserve) {
      const { saleId } = parseInput(z.object({ saleId: z.uuid() }), request.body);
      await this.requirePublished(saleId, response);
    }
    let upstream: globalThis.Response;
    let body: unknown;
    const { service } = route;
    try {
      const url = upstreamUrl(this.auth.config[`${service}_URL`], path, request.originalUrl);
      const key = request.header('idempotency-key');
      const analyticsSession =
        route.reserve && this.analytics.enabled
          ? this.analytics.session.read(request)?.id
          : undefined;
      upstream = await fetch(url, {
        method: request.method,
        redirect: 'error',
        signal: AbortSignal.timeout(ORDER_PROXY_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          'x-request-id': response.locals.requestId,
          traceparent: response.locals.traceparent,
          ...(key ? { 'idempotency-key': key } : {}),
          ...(analyticsSession ? { 'x-analytics-session': analyticsSession } : {}),
        },
        ...(request.method === 'GET' || request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
      });
      if (upstream.status >= 500) {
        await upstream.body?.cancel();
        throw new Error('Order upstream unavailable');
      }
      if (route.png && upstream.ok) {
        await this.forwardQr(upstream, response);
        return;
      }
      body = await upstream.json();
    } catch {
      throw this.unavailable(service);
    }
    response.setHeader('cache-control', 'no-store');
    response.status(upstream.status).json(body);
  }
  private async forwardQr(upstream: globalThis.Response, response: Response) {
    if (upstream.status !== 200 || upstream.headers.get('content-type') !== 'image/png') {
      await upstream.body?.cancel();
      throw new Error('Unexpected ticket QR response');
    }
    const png = Buffer.from(await upstream.arrayBuffer());
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'image/png');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.status(200).end(png);
  }
  private unavailable(service: OrderUpstream) {
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
        signal: AbortSignal.timeout(ORDER_PUBLICATION_CHECK_TIMEOUT_MS),
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
