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
export class CatalogOps {
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
    const sql = `SELECT id::text,'mail'::text AS kind,state,NULL::text AS code,NULL::text AS "orderId","nextRunAt" AS at,traceparent FROM "DeliveryJob" WHERE state='DEAD'`;
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
