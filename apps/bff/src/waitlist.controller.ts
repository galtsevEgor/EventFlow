import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '@eventflow/service-runtime';
import { AuthService } from './auth/auth.service';
import { upstreamUrl } from './upstream-url';

const WAITLIST_RATE_LIMIT = 60;
const WAITLIST_PROXY_TIMEOUT_MS = 15_000;

@Controller()
export class WaitlistProxy {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @All([
    'api/v1/waitlist',
    'api/v1/waitlist/:id',
    'api/v1/waitlist/:id/cancel',
    'api/v1/events/:id/waitlist',
    'api/v1/organizations/:org/events/:id/waitlist',
  ])
  async proxy(@Req() req: Request, @Res() res: Response) {
    const id = '[a-f0-9-]{36}',
      path = req.path;
    const publicRead =
      req.method === 'GET' && new RegExp('^/api/v1/events/' + id + '/waitlist$').test(path);
    const own =
      req.method === 'GET'
        ? new RegExp('^/api/v1/waitlist(?:/' + id + ')?$').test(path)
        : req.method === 'POST' &&
          new RegExp('^/api/v1/waitlist(?:/' + id + '/cancel)?$').test(path);
    const organizer =
      ['GET', 'PUT'].includes(req.method) &&
      new RegExp('^/api/v1/organizations/' + id + '/events/' + id + '/waitlist$').test(path);
    if (!publicRead && !own && !organizer)
      throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    let token: string | undefined;
    if (!publicRead) {
      const { session } = await this.auth.requireSession(req);
      if (!session.user.emailVerified)
        throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
      if (req.method !== 'GET') this.auth.assertCsrf(req, session.csrf);
      await this.auth.store.rateLimit('waitlist:' + session.user.sub, WAITLIST_RATE_LIMIT);
      token = session.accessToken;
    }
    if (this.auth.config.WAITLIST_ENABLED !== 'true') {
      res.setHeader('cache-control', 'no-store');
      if (publicRead) {
        res.json({ enabled: false, state: 'CLOSED', categories: [] });
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/waitlist') {
        res.json({ entries: [] });
        return;
      }
      throw new ApiError(404, 'NOT_FOUND', 'Лист ожидания отключён.');
    }
    try {
      const upstream = await fetch(
        upstreamUrl(this.auth.config.WAITLIST_URL, path, req.originalUrl),
        {
          method: req.method,
          redirect: 'error',
          signal: AbortSignal.timeout(WAITLIST_PROXY_TIMEOUT_MS),
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: 'Bearer ' + token } : {}),
          },
          ...(req.method === 'GET' ? {} : { body: JSON.stringify(req.body ?? {}) }),
        },
      );
      if (upstream.status >= 500) {
        await upstream.body?.cancel();
        throw new Error('Waitlist unavailable');
      }
      const body = await upstream.json();
      res.setHeader('cache-control', 'no-store');
      res.status(upstream.status).json(body);
    } catch {
      throw new ApiError(
        503,
        'WAITLIST_UNAVAILABLE',
        'Лист ожидания временно недоступен. Повторите запрос позже.',
      );
    }
  }
}
