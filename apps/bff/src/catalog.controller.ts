import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '@eventflow/service-runtime';
import { AuthService } from './auth/auth.service';
import { requireProxySession } from './auth/proxy-session';
import { isCatalogRoute, isOrganizerOrderRoute } from './catalog.routes';
import { upstreamUrl } from './upstream-url';

const CATALOG_API_RATE = { scope: 'api', limit: 120 };
const CATALOG_PROXY_TIMEOUT_MS = 5_000;

@Controller('api/v1')
export class CatalogController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @All(['organizations', 'organizations/{*path}', 'invitations/accept'])
  async forward(@Req() request: Request, @Res() response: Response) {
    const organizerOrder = isOrganizerOrderRoute(request.method, request.path);
    if (!organizerOrder && !isCatalogRoute(request.method, request.path))
      throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    const session = await requireProxySession(this.auth, request, CATALOG_API_RATE);
    let upstream: globalThis.Response;
    const idempotencyKey = request.header('idempotency-key');
    try {
      upstream = await fetch(
        upstreamUrl(
          organizerOrder ? this.auth.config.BOOKING_URL : this.auth.config.CATALOG_URL,
          request.path,
          request.originalUrl,
        ),
        {
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
          signal: AbortSignal.timeout(CATALOG_PROXY_TIMEOUT_MS),
          redirect: 'error',
        },
      );
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
