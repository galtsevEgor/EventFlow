import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '@eventflow/service-runtime';
import { AuthService } from './auth/auth.service';

const CHECK_IN_RATE_LIMIT = 120;

@Controller('api/v1/check-in')
export class CheckInProxy {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post()
  async forward(@Req() request: Request, @Res() response: Response) {
    const { session } = await this.auth.requireSession(request);
    this.auth.assertCsrf(request, session.csrf);
    await this.auth.store.rateLimit(`check-in:${session.user.sub}`, CHECK_IN_RATE_LIMIT);
    let status: number;
    let body: unknown;
    try {
      const result = await fetch(new URL('/api/v1/check-in', this.auth.config.TICKETS_URL), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          'x-request-id': response.locals.requestId,
          traceparent: response.locals.traceparent,
        },
        body: JSON.stringify(request.body ?? {}),
      });
      status = result.status;
      body = await result.json();
      if (status >= 500) throw new Error('Check-in unavailable');
    } catch {
      throw new ApiError(503, 'CHECK_IN_UNAVAILABLE', 'Допуск не подтверждён. Повторите проверку.');
    }
    response.status(status).json(body);
  }
}
