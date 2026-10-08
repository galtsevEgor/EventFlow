import { Controller, Get, Headers, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { mailDetail } from './ops/detail';
import { parseInput, queryOperatorPage, TokenVerifier } from '@eventflow/service-runtime';
import { opsPage, opsQuerySchema, type RawOpsIssue } from '@eventflow/event-contracts';
import { Database } from './database';

@Controller('internal/ops')
export class TicketOps {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  @Get('issues/:kind/:id')
  async detail(
    @Headers('authorization') authorization: string | undefined,
    @Param('kind') kind: string,
    @Param('id') id: string,
  ) {
    const actor = await this.verifier.operator(authorization);
    parseInput(z.literal('mail'), kind);
    return mailDetail(this.db, parseInput(z.uuid(), id), actor.canRecover);
  }
  @Get('issues')
  async list(@Headers('authorization') authorization: string | undefined, @Query() raw: unknown) {
    await this.verifier.operator(authorization);
    const query = parseInput(opsQuerySchema, raw);
    const sql = `SELECT j.id::text,'mail'::text AS kind,j.state,NULL::text AS code,COALESCE(g."orderId",(SELECT "orderId" FROM "Ticket" WHERE "orderId"=j.id LIMIT 1))::text AS "orderId",j."nextRunAt" AS at,j.traceparent
      FROM "DeliveryJob" j LEFT JOIN "RefundGate" g ON g."operationId"=j.id WHERE j.state='DEAD'`;
    return opsPage(
      await queryOperatorPage<RawOpsIssue>(
        (sql, ...values) => this.db.$queryRawUnsafe(sql, ...values),
        sql,
        query,
      ),
      query.limit,
    );
  }
}
