import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '@eventflow/service-runtime';
import { AuthService } from './auth/auth.service';
import { isCatalogRoute } from './catalog.routes';

@Controller('api/v1')
export class CatalogController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @All(['organizations', 'organizations/{*path}', 'invitations/accept'])
  async forward(@Req() request: Request, @Res() response: Response) {
    if (!isCatalogRoute(request.method, request.path))
      throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    const { session } = await this.auth.requireSession(request);
    if (request.method !== 'GET') this.auth.assertCsrf(request, session.csrf);
    await this.auth.store.rateLimit(`api:${session.user.sub}`, 120);
    let upstream: globalThis.Response;
    const idempotencyKey = request.header('idempotency-key');
    try {
      upstream = await fetch(new URL(request.path, this.auth.config.CATALOG_URL), {
        method: request.method,
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          'x-request-id': response.locals.requestId,
          traceparent: response.locals.traceparent,
        },
        ...(request.method === 'GET' || request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch {
      throw new ApiError(
        503,
        'CATALOG_UNAVAILABLE',
        'Организации временно недоступны. Повторите позже.',
      );
    }
    if (upstream.status >= 500)
      throw new ApiError(
        503,
        'CATALOG_UNAVAILABLE',
        'Организации временно недоступны. Повторите позже.',
      );
    response.setHeader('cache-control', 'no-store');
    response.status(upstream.status).json(await upstream.json());
  }
}
