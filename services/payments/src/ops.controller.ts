import { Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import { parseInput, queryOperatorPage, TokenVerifier } from '@eventflow/service-runtime';
import { opsPage, opsQuerySchema, type RawOpsIssue } from '@eventflow/event-contracts';
import { Database } from './database';

const issues = `SELECT id::text, 'payment'::text AS kind, state::text AS state, "reviewCode" AS code, "orderId"::text, "createdAt" AS at, traceparent FROM "PaymentAttempt"
  WHERE state IN ('NEEDS_RECONCILIATION','REQUIRES_REVIEW') OR "bookingState"='REQUIRES_REVIEW'
  UNION ALL SELECT id::text,'refund',state::text,"reviewCode","orderId"::text,"createdAt",traceparent FROM "RefundOperation" WHERE state IN ('UNKNOWN','REQUIRES_REVIEW')
  UNION ALL SELECT "eventId",'webhook','REQUIRES_REVIEW',"reviewCode",NULL::text,"createdAt",traceparent FROM "ProviderWebhook" WHERE "reviewCode" IS NOT NULL`;

@Controller('internal/ops')
export class PaymentOps {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
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
