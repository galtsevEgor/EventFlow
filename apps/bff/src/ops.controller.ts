import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import {
  opsDetailSchema,
  opsOrderSchema,
  opsKind,
  opsPageSchema,
  opsQuerySchema,
  opsRecoverySchema,
} from '@eventflow/event-contracts';
import { z } from 'zod';
import { AuthService } from './auth/auth.service';

@Controller('api/v1/ops')
export class OpsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}

  @Get('access')
  async access(@Req() request: Request) {
    const { actor } = await this.authorize(request);
    return { canRecover: actor.canRecover };
  }
  async authorize(request: Request, recover = false) {
    const { session } = await this.auth.requireSession(request);
    const actor = await this.verifier.operator(`Bearer ${session.accessToken}`, recover);
    if (actor.subject !== session.user.sub)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Сессия завершилась.');
    if (request.method !== 'GET') this.auth.assertCsrf(request, session.csrf);
    await this.auth.store.rateLimit(`ops:${actor.subject}`, 120);
    return { session, actor };
  }
  private origin(service: 'payments' | 'catalog' | 'tickets') {
    return {
      payments: this.auth.config.PAYMENTS_URL,
      catalog: this.auth.config.CATALOG_URL,
      tickets: this.auth.config.TICKETS_URL,
    }[service];
  }
  @Post('issues/:service/:kind/:id/recover')
  @HttpCode(202)
  async recover(
    @Req() request: Request,
    @Param('service') rawService: string,
    @Param('kind') rawKind: string,
    @Param('id') rawId: string,
    @Body() raw: unknown,
  ) {
    const { session } = await this.authorize(request, true),
      service = parseInput(z.enum(['payments', 'catalog', 'tickets']), rawService),
      kind = parseInput(opsKind, rawKind),
      id = parseInput(z.uuid(), rawId).toLowerCase(),
      data = parseInput(opsRecoverySchema, raw),
      key = parseInput(z.uuid(), request.header('idempotency-key')).toLowerCase();
    if (
      (service === 'payments' && !['payment', 'refund'].includes(kind)) ||
      (service !== 'payments' && kind !== 'mail')
    )
      throw new ApiError(422, 'NO_RECOVERY_ACTION', 'Для этой записи нет команды восстановления.');
    const result = await fetch(
      new URL(`/internal/ops/issues/${kind}/${id}/recover`, this.origin(service)),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(data),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      },
    ).catch(() => null);
    if (!result)
      throw new ApiError(
        503,
        'OPS_SOURCE_UNAVAILABLE',
        'Ответ не получен. Повторите запрос с прежним ключом.',
      );
    const body = await result.json().catch(() => null);
    if (result.status !== 202 || body?.accepted !== true) {
      const messages: Record<string, string> = {
        STALE_OPERATION: 'Запись изменилась. Обновите карточку.',
        IDEMPOTENCY_CONFLICT: 'Ключ использован для другого действия.',
        OPERATION_BUSY: 'Операцию обрабатывает worker. Обновите статус.',
        INVESTIGATION_REQUIRED: 'Требуется разбор привязки платежа.',
        NOT_RECOVERABLE: 'Сверка сейчас не требуется.',
        DELIVERY_NOT_DEAD: 'Задача недоступна для повтора.',
      };
      if (result.status === 409) {
        const code =
          typeof body?.code === 'string' && Object.hasOwn(messages, body.code)
            ? body.code
            : 'RECOVERY_CONFLICT';
        throw new ApiError(
          409,
          code,
          messages[code] ?? 'Состояние записи изменилось. Обновите карточку.',
        );
      }
      throw new ApiError(
        [401, 403, 404, 422].includes(result.status) ? result.status : 503,
        'RECOVERY_UNAVAILABLE',
        'Действие сейчас недоступно.',
      );
    }
    return { accepted: true };
  }
  @Get('issues/:service/:kind/:id')
  async detail(
    @Req() request: Request,
    @Param('service') rawService: string,
    @Param('kind') rawKind: string,
    @Param('id') rawId: string,
  ) {
    const { session } = await this.authorize(request),
      service = parseInput(z.enum(['payments', 'catalog', 'tickets']), rawService),
      kind = parseInput(opsKind, rawKind),
      id = parseInput(z.string().regex(/^[A-Za-z0-9_-]{1,255}$/), rawId);
    const response = await fetch(
      new URL(`/internal/ops/issues/${kind}/${encodeURIComponent(id)}`, this.origin(service)),
      {
        headers: { authorization: `Bearer ${session.accessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      },
    ).catch(() => null);
    if (!response)
      throw new ApiError(503, 'OPS_SOURCE_UNAVAILABLE', 'Источник временно недоступен.');
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(
        [401, 403, 404, 422].includes(response.status) ? response.status : 503,
        'OPS_CASE_UNAVAILABLE',
        'Запись недоступна.',
      );
    }
    const parsed = opsDetailSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success)
      throw new ApiError(503, 'OPS_SOURCE_UNAVAILABLE', 'Источник вернул неполный ответ.');
    const detail = parsed.data;
    let order: z.infer<typeof opsOrderSchema> | null = null,
      orderStatus: 'available' | 'missing' | 'unavailable' | 'none' = detail.issue.orderId
        ? 'unavailable'
        : 'none';
    if (detail.issue.orderId) {
      try {
        const result = await fetch(
          new URL(`/internal/ops/orders/${detail.issue.orderId}`, this.auth.config.BOOKING_URL),
          {
            headers: { authorization: `Bearer ${session.accessToken}` },
            redirect: 'error',
            signal: AbortSignal.timeout(2000),
          },
        );
        if (result.ok) {
          order = opsOrderSchema.parse(await result.json());
          orderStatus = 'available';
        } else {
          await result.body?.cancel();
          orderStatus = result.status === 404 ? 'missing' : 'unavailable';
        }
      } catch {
        /* The primary case remains available when Booking is down. */
      }
    }
    return {
      ...detail,
      order,
      orderStatus,
      traceUrl: detail.issue.traceId
        ? new URL(
            `/d/eventflow-trace?var-traceId=${detail.issue.traceId}`,
            this.auth.config.OBSERVABILITY_PUBLIC_ORIGIN,
          ).href
        : null,
    };
  }
  private async page(service: 'payments' | 'catalog' | 'tickets', raw: unknown, token: string) {
    const query = parseInput(opsQuerySchema, raw),
      url = new URL('/internal/ops/issues', this.origin(service));
    const params = raw as Record<string, string>;
    for (const key of ['limit', 'kind', 'orderId', 'cursor'])
      if (params[key]) url.searchParams.set(key, params[key]);
    url.searchParams.set('limit', String(query.limit));
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status))
        throw new ApiError(response.status, 'FORBIDDEN', 'Недостаточно полномочий оператора.');
      throw new Error('Source unavailable');
    }
    return opsPageSchema.parse(await response.json());
  }
  @Get('issues')
  async overview(@Req() request: Request, @Query() raw: unknown) {
    const { session } = await this.authorize(request);
    parseInput(opsQuerySchema, raw);
    const sources = await Promise.all(
      (['payments', 'catalog', 'tickets'] as const).map(async (service) => {
        try {
          return {
            service,
            available: true,
            ...(await this.page(service, raw, session.accessToken)),
          };
        } catch (error) {
          if (error instanceof ApiError) throw error;
          return { service, available: false, items: [], nextCursor: null };
        }
      }),
    );
    return { sources };
  }
  @Get('issues/:service')
  async list(
    @Req() request: Request,
    @Param('service') rawService: string,
    @Query() query: unknown,
  ) {
    const { session } = await this.authorize(request),
      service = parseInput(z.enum(['payments', 'catalog', 'tickets']), rawService);
    try {
      return await this.page(service, query, session.accessToken);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'OPS_SOURCE_UNAVAILABLE', 'Источник временно недоступен.');
    }
  }
}
