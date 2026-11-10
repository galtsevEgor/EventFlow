import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { ApiError } from '@eventflow/service-runtime';
import { draftSnapshotSchema, type DraftSnapshot } from '@eventflow/collaboration';
import { AuthService } from '../auth/auth.service';

const COLLABORATION_WRITE_RATE_LIMIT = 120;

export type DocumentTarget = { organizationId: string; eventId: string };

export function socketRequest(request: IncomingMessage): Request {
  return {
    headers: request.headers,
    socket: request.socket,
    header: (name: string) => {
      const value = request.headers[name.toLowerCase()];
      return typeof value === 'string' ? value : undefined;
    },
  } as Request;
}

export class DocumentAccess {
  identity = { name: 'Участник', color: '#315eac' };
  private sessionId: string | undefined;
  private subject: string | undefined;
  constructor(
    private readonly auth: AuthService,
    private readonly request: Request,
    readonly target: DocumentTarget,
  ) {}

  async load(update?: { epoch: string; state: string }): Promise<DraftSnapshot> {
    const { id, session } = await this.auth.requireSession(this.request);
    if (
      !session.user.emailVerified ||
      (this.sessionId && (id !== this.sessionId || session.user.sub !== this.subject))
    )
      throw new ApiError(401, 'UNAUTHENTICATED', 'Сессия завершена.');
    this.sessionId = id;
    this.subject = session.user.sub;
    const colors = ['#315eac', '#86602d', '#9453a6', '#247766', '#ac425b', '#666a27'];
    this.identity = {
      name: session.user.name.trim().slice(0, 80) || 'Участник',
      color: colors[createHash('sha256').update(session.user.sub).digest()[0]! % colors.length]!,
    };
    if (update)
      await this.auth.store.rateLimit(
        'collaboration-write:' + session.user.sub,
        COLLABORATION_WRITE_RATE_LIMIT,
      );
    const response = await fetch(
      new URL(
        '/internal/collaboration/' + this.target.organizationId + '/' + this.target.eventId,
        this.auth.config.CATALOG_URL,
      ),
      {
        method: update ? 'POST' : 'GET',
        headers: {
          authorization: 'Bearer ' + session.accessToken,
          ...(update ? { 'content-type': 'application/json' } : {}),
        },
        ...(update ? { body: JSON.stringify(update) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      },
    ).catch(() => null);
    if (!response)
      throw new ApiError(503, 'COLLABORATION_UNAVAILABLE', 'Редактор временно недоступен.');
    if (!response.ok) {
      await response.body?.cancel();
      const status = [401, 403, 404, 409, 422, 429].includes(response.status)
        ? response.status
        : 503;
      const code =
        status === 409
          ? 'DRAFT_CLOSED'
          : status === 422
            ? 'INVALID_DOCUMENT'
            : status === 503
              ? 'COLLABORATION_UNAVAILABLE'
              : 'ACCESS_DENIED';
      throw new ApiError(
        status,
        code,
        status === 409
          ? 'Редактирование документа завершено или его версия изменилась.'
          : 'Не удалось принять изменения или проверить доступ.',
      );
    }
    const parsed = draftSnapshotSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success)
      throw new ApiError(503, 'COLLABORATION_UNAVAILABLE', 'Получен неполный ответ редактора.');
    return parsed.data;
  }
}
