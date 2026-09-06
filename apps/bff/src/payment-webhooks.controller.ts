import { Controller, Inject, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import { ApiError } from '@eventflow/service-runtime';
import type { Request, Response } from 'express';
import { AUTH_CONFIG, type AuthConfig } from './auth/config';

@Controller('api/v1/webhooks')
export class PaymentWebhooksController {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  @Post('stripe')
  async stripe(@Req() request: RawBodyRequest<Request>, @Res() response: Response) {
    const signature = request.header('stripe-signature');
    if (!signature || !request.rawBody || !request.is('application/json'))
      throw new ApiError(400, 'INVALID_WEBHOOK', 'Ожидаются подписанные данные Stripe.');
    let upstream: globalThis.Response;
    let body: unknown;
    try {
      upstream = await fetch(new URL('/api/v1/webhooks/stripe', this.config.PAYMENTS_URL), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signature,
          'x-request-id': response.locals.requestId,
          traceparent: response.locals.traceparent,
        },
        body: new Uint8Array(request.rawBody),
      });
      body = await upstream.json();
    } catch {
      throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Повторите доставку события.');
    }
    if (upstream.status >= 500)
      throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Повторите доставку события.');
    response.setHeader('cache-control', 'no-store');
    response.status(upstream.status).json(body);
  }
}
