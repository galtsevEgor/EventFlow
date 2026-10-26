import { ApiError } from '@eventflow/service-runtime';
import type { Request } from 'express';
import type { RealtimeHint } from '@eventflow/event-contracts';
import { AuthService } from '../auth/auth.service';

export class UpdatesAccess {
  constructor(private readonly auth: AuthService) {}
  async open(request: Request, target: RealtimeHint) {
    if (
      (request.header('origin') && request.header('origin') !== this.auth.config.PUBLIC_ORIGIN) ||
      (request.header('sec-fetch-site') &&
        !['same-origin', 'none'].includes(request.header('sec-fetch-site')!))
    )
      throw new ApiError(403, 'FORBIDDEN', 'Подключение недоступно.');
    if (target.scope === 'sale') {
      await this.probe(`/api/v1/events/${target.id}`, undefined, this.auth.config.CATALOG_URL);
      await this.probe(`/api/v1/sales/${target.id}`);
      return {
        principal: `ip:${request.socket.remoteAddress ?? 'unknown'}`,
        check: async () => {},
      };
    }
    const first = await this.auth.requireSession(request);
    if (!first.session.user.emailVerified)
      throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
    const path =
      target.scope === 'waitlist'
        ? '/api/v1/waitlist/' + target.id
        : target.scope === 'order'
          ? `/api/v1/orders/${target.id}`
          : `/internal/organizations/${target.organizationId}/events/${target.id}/order-updates-access`;
    await this.probe(
      path,
      first.session.accessToken,
      target.scope === 'waitlist' ? this.auth.config.WAITLIST_URL : this.auth.config.BOOKING_URL,
    );
    return {
      principal: `user:${first.session.user.sub}`,
      check: async () => {
        const current = await this.auth.requireSession(request);
        if (
          current.id !== first.id ||
          current.session.user.sub !== first.session.user.sub ||
          !current.session.user.emailVerified
        )
          throw new ApiError(401, 'UNAUTHENTICATED', 'Войдите в аккаунт.');
        if (target.scope === 'organizer-orders')
          await this.probe(path, current.session.accessToken);
      },
    };
  }
  private async probe(path: string, token?: string, base = this.auth.config.BOOKING_URL) {
    let response: globalThis.Response;
    try {
      response = await fetch(new URL(path, base), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      throw new ApiError(503, 'UPDATES_UNAVAILABLE', 'Автообновление временно недоступно.');
    }
    await response.body?.cancel();
    if (response.status === 200) return;
    const status = [401, 403, 404].includes(response.status) ? response.status : 503;
    throw new ApiError(
      status,
      status === 503 ? 'UPDATES_UNAVAILABLE' : 'NOT_FOUND',
      'Подключение недоступно.',
    );
  }
}
