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
import { parseInput, queryOperatorPage, TokenVerifier } from '@eventflow/service-runtime';
import {
  opsPage,
  opsQuerySchema,
  opsRecoverySchema,
  type RawOpsIssue,
} from '@eventflow/event-contracts';
import { z } from 'zod';
import { Database } from './database';
import { readPaymentIssueDetail } from './ops/detail';
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
    return readPaymentIssueDetail(this.db, kind, id, actor.canRecover);
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
