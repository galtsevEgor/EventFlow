import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiError,
  operationVersion,
  parseInput,
  queryOperatorPage,
  TokenVerifier,
} from '@eventflow/service-runtime';
import {
  opsIssue,
  opsPage,
  opsQuerySchema,
  opsRecoverySchema,
  type RawOpsIssue,
} from '@eventflow/event-contracts';
import { validTraceparent } from '@eventflow/telemetry';
import { z } from 'zod';
import { paymentVersion, refundVersion } from './ops/versions';
import { Database } from './database';
import { ReconcilePayment } from './ops/reconcile';

const issues = `SELECT id::text, 'payment'::text AS kind, state::text AS state, "reviewCode" AS code, "orderId"::text, "createdAt" AS at, traceparent FROM "PaymentAttempt"
  WHERE state IN ('NEEDS_RECONCILIATION','REQUIRES_REVIEW') OR "bookingState"='REQUIRES_REVIEW'
  UNION ALL SELECT id::text,'refund',state::text,"reviewCode","orderId"::text,"createdAt",traceparent FROM "RefundOperation" WHERE state IN ('UNKNOWN','REQUIRES_REVIEW')
  UNION ALL SELECT "eventId",'webhook','REQUIRES_REVIEW',"reviewCode",NULL::text,"createdAt",traceparent FROM "ProviderWebhook" WHERE "reviewCode" IS NOT NULL`;

@Controller('internal/ops')
export class PaymentOps {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(ReconcilePayment) private readonly recovery: ReconcilePayment,
  ) {}
  @Post('issues/:kind/:id/recover')
  @HttpCode(202)
  async recover(
    @Headers('authorization') auth: string | undefined,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Param('kind') rawKind: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const actor = await this.verifier.operator(auth, true),
      data = parseInput(opsRecoverySchema, raw),
      kind = parseInput(z.enum(['payment', 'refund']), rawKind),
      key = parseInput(z.uuid(), rawKey).toLowerCase();
    return this.recovery.run(
      actor.subject,
      key,
      { kind, targetId: parseInput(z.uuid(), id), reason: data.reason },
      'HUMAN',
      data.version,
    );
  }
  @Get('issues/:kind/:id')
  async detail(
    @Headers('authorization') authorization: string | undefined,
    @Param('kind') rawKind: string,
    @Param('id') rawId: string,
  ) {
    const actor = await this.verifier.operator(authorization),
      kind = parseInput(z.enum(['payment', 'refund', 'webhook']), rawKind);
    const id = parseInput(
      kind === 'webhook' ? z.string().regex(/^[A-Za-z0-9_-]{1,255}$/) : z.uuid(),
      rawId,
    );
    if (kind === 'webhook') {
      const row = await this.db.providerWebhook.findUnique({
        where: { eventId: id },
        select: {
          eventId: true,
          reviewCode: true,
          failures: true,
          processedAt: true,
          createdAt: true,
          nextRunAt: true,
          traceparent: true,
        },
      });
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Запись не найдена.');
      return {
        issue: opsIssue({
          id: row.eventId,
          kind,
          state: row.reviewCode ? 'REQUIRES_REVIEW' : row.processedAt ? 'PROCESSED' : 'PENDING',
          code: row.reviewCode,
          orderId: null,
          at: row.createdAt,
          traceparent: row.traceparent,
        }),
        version: operationVersion(row.reviewCode, row.failures, row.processedAt),
        recoverable: false,
        facts: { attempts: row.failures, nextRunAt: row.nextRunAt.toISOString() },
        actions: [],
      };
    }
    const row =
      kind === 'payment'
        ? await this.db.paymentAttempt.findUnique({
            where: { id },
            select: {
              id: true,
              orderId: true,
              state: true,
              bookingState: true,
              reviewCode: true,
              failures: true,
              nextRunAt: true,
              leaseUntil: true,
              cancelRequested: true,
              authorized: true,
              recoveryKey: true,
              amountMinor: true,
              currency: true,
              createdAt: true,
              traceparent: true,
            },
          })
        : await this.db.refundOperation.findUnique({
            where: { id },
            select: {
              id: true,
              orderId: true,
              state: true,
              reviewCode: true,
              failures: true,
              nextRunAt: true,
              leaseUntil: true,
              recoveryKey: true,
              amountMinor: true,
              currency: true,
              createdAt: true,
              traceparent: true,
            },
          });
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Запись не найдена.');
    const payment = 'bookingState' in row ? row : undefined;
    const recoverable =
      actor.canRecover &&
      !(row.leaseUntil && row.leaseUntil > new Date()) &&
      (payment
        ? ['NEEDS_RECONCILIATION', 'REQUIRES_REVIEW'].includes(payment.state) &&
          payment.reviewCode !== 'BOOKING_BINDING_REVIEW'
        : ['UNKNOWN', 'REQUIRES_REVIEW'].includes(row.state));
    const actions = await this.db.operatorAction.findMany({
      where: { kind, targetId: id },
      orderBy: [{ createdAt: 'desc' }, { key: 'desc' }],
      take: 20,
      select: {
        key: true,
        actor: true,
        reason: true,
        createdAt: true,
        actorType: true,
        traceparent: true,
      },
    });
    return {
      issue: opsIssue({
        id,
        kind,
        state: row.state,
        code: row.reviewCode,
        orderId: row.orderId,
        at: row.createdAt,
        traceparent: row.traceparent,
      }),
      version: 'bookingState' in row ? paymentVersion(row) : refundVersion(row),
      recoverable,
      facts: {
        amountMinor: row.amountMinor,
        currency: row.currency,
        ...(payment ? { bookingState: payment.bookingState } : {}),
        attempts: row.failures,
        nextRunAt: row.nextRunAt.toISOString(),
      },
      actions: actions.map((action) => ({
        key: action.key,
        actor: action.actor,
        reason: action.reason,
        actorType: action.actorType === 'HUMAN' ? ('HUMAN' as const) : ('SERVICE' as const),
        createdAt: action.createdAt.toISOString(),
        traceId: validTraceparent(action.traceparent)?.split('-')[1] ?? null,
      })),
    };
  }
  @Get('issues')
  async list(@Headers('authorization') authorization: string | undefined, @Query() raw: unknown) {
    await this.verifier.operator(authorization);
    const query = parseInput(opsQuerySchema, raw);
    return opsPage(
      await queryOperatorPage<RawOpsIssue>(
        (sql, ...values) => this.db.$queryRawUnsafe(sql, ...values),
        issues,
        query,
      ),
      query.limit,
    );
  }
}
