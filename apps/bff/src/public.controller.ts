import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import { AuthService } from './auth/auth.service';

@Controller('api/v1')
export class PublicController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Get(['events', 'events/:id']) async events(@Req() request: Request, @Res() response: Response) {
    const upstream = await this.request(
      new URL(request.originalUrl, this.auth.config.CATALOG_URL),
      response,
    );
    response.setHeader('cache-control', upstream.headers.get('cache-control') ?? 'no-store');
    response.status(upstream.status).json(await upstream.json());
  }
  @Get('sales/:id') async sale(@Param('id') rawId: string, @Res() response: Response) {
    const id = parseInput(z.uuid(), rawId);
    const published = await this.request(
      new URL(`/api/v1/events/${id}`, this.auth.config.CATALOG_URL),
      response,
    );
    if (!published.ok) {
      response.status(published.status).json(await published.json());
      return;
    }
    await published.body?.cancel();
    const upstream = await this.request(
      new URL(`/api/v1/sales/${id}`, this.auth.config.BOOKING_URL),
      response,
    );
    response.setHeader('cache-control', 'no-store');
    response.status(upstream.status).json(await upstream.json());
  }
  private async request(url: URL, response: Response) {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(url, {
        headers: {
          'x-request-id': response.locals.requestId,
          traceparent: response.locals.traceparent,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ApiError(
        503,
        'EVENTS_UNAVAILABLE',
        'Мероприятия временно недоступны. Повторите позже.',
      );
    }
    if (upstream.status >= 500) {
      await upstream.body?.cancel();
      throw new ApiError(
        503,
        'EVENTS_UNAVAILABLE',
        'Мероприятия временно недоступны. Повторите позже.',
      );
    }
    return upstream;
  }
}
