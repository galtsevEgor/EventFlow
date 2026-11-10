import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Request } from 'express';
import { parseCookie, stringifySetCookie } from 'cookie';
import { ApiError } from '@eventflow/service-runtime';
import { opaqueId, SessionStore } from './session-store';
import { IdentityProvider } from './oidc';
import type { AuthConfig } from './config';
import { SESSION_REFRESH_AHEAD_MS } from './session-policy';

const SESSION_READ_ATTEMPTS = 60;
const REFRESH_LOCK_POLL_INTERVAL_MS = 100;

export class AuthService {
  constructor(
    readonly config: AuthConfig,
    readonly store: SessionStore,
    readonly identity: IdentityProvider,
  ) {}
  cookieName(kind: 'session' | 'flow') {
    return `${this.config.secure ? '__Host-' : ''}eventflow_${kind}`;
  }
  cookie(kind: 'session' | 'flow', value: string, maxAge: number) {
    return stringifySetCookie({
      name: this.cookieName(kind),
      value,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.secure,
      maxAge,
    });
  }
  readCookie(request: Request, kind: 'session' | 'flow') {
    const value = parseCookie(request.headers.cookie ?? '')[this.cookieName(kind)];
    return value && /^[\w-]{43}$/.test(value) ? value : undefined;
  }
  async requireSession(request: Request) {
    const id = this.readCookie(request, 'session');
    if (!id) throw new ApiError(401, 'UNAUTHENTICATED', 'Войдите в аккаунт.');
    for (let attempt = 0; attempt < SESSION_READ_ATTEMPTS; attempt++) {
      const record = await this.store.read(id);
      if (!record) throw new ApiError(401, 'UNAUTHENTICATED', 'Войдите в аккаунт.');
      if (record.session.accessExpiresAt > Date.now() + SESSION_REFRESH_AHEAD_MS) {
        if (!(await this.store.replace(id, record.raw, record.session))) continue;
        return { id, session: record.session };
      }
      const lockOwner = opaqueId();
      if (!(await this.store.acquireRefresh(id, lockOwner))) {
        await delay(REFRESH_LOCK_POLL_INTERVAL_MS);
        continue;
      }
      try {
        const latest = await this.store.read(id);
        if (!latest) throw new ApiError(401, 'UNAUTHENTICATED', 'Войдите в аккаунт.');
        if (latest.session.accessExpiresAt > Date.now() + SESSION_REFRESH_AHEAD_MS) continue;
        const updated = await this.identity.refresh(latest.session);
        if (!(await this.store.replace(id, latest.raw, updated)))
          throw new ApiError(401, 'UNAUTHENTICATED', 'Сессия завершена.');
        return { id, session: updated };
      } catch (error) {
        if (error instanceof ApiError && error.getStatus() === 401) await this.store.destroy(id);
        throw error;
      } finally {
        await this.store.releaseRefresh(id, lockOwner);
      }
    }
    throw new ApiError(503, 'SESSION_BUSY', 'Сессия обновляется. Повторите запрос.');
  }
  assertCsrf(request: Request, expected: string) {
    const value = request.header('x-csrf-token') ?? '';
    if (
      request.header('origin') !== this.config.PUBLIC_ORIGIN ||
      Buffer.byteLength(value) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(expected))
    ) {
      throw new ApiError(403, 'CSRF_FAILED', 'Обновите страницу и повторите действие.');
    }
  }
}
