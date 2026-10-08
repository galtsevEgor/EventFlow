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
import { z } from 'zod';
import { mailDetail } from './ops/detail';
import {
  MailQueue,
  parseInput,
  queryOperatorPage,
  TokenVerifier,
} from '@eventflow/service-runtime';
import {
  opsPage,
  opsQuerySchema,
  opsRecoverySchema,
  type RawOpsIssue,
} from '@eventflow/event-contracts';
import { Database } from './database';

@Controller('internal/ops')
export class TicketOps {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(MailQueue) private readonly queue: MailQueue,
  ) {}
  @Post('issues/:kind/:id/recover')
  @HttpCode(202)
  async recover(
    @Headers('authorization') auth: string | undefined,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const actor = await this.verifier.operator(auth, true),
      data = parseInput(opsRecoverySchema, raw);
    parseInput(z.literal('mail'), kind);
    await this.queue.retry(
      parseInput(z.uuid(), id).toLowerCase(),
      parseInput(z.uuid(), rawKey).toLowerCase(),
      actor.subject,
      { reason: data.reason, version: data.version, actorType: 'HUMAN' },
    );
    return { accepted: true };
  }
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
