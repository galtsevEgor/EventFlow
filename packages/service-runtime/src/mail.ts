import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { z } from 'zod';
import { ApiError, parseInput } from './http';
import { TokenVerifier } from './identity';
import { operationVersion } from './operator-page';
import {
  currentTelemetry,
  observedJob,
  operation,
  traceFailure,
  currentTraceparent,
  linkTrace,
  type Telemetry,
} from '@eventflow/telemetry';

const delays = [5000, 30_000, 120_000];
const maxAttempts = delays.length + 1;
type Query = <T>(sql: string, ...values: unknown[]) => Promise<T>;
type Transaction = <T>(operation: (query: Query) => Promise<T>) => Promise<T>;
type Job = { id: string; lease: string; attempts: number; traceparent: string | null };
type Send = (id: string) => Promise<'SENT' | 'SKIPPED'>;

export const mailConfig = {
  PUBLIC_ORIGIN: z.url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.href === url.origin + '/';
  }),
  MAILPIT_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(11025),
  MAILPIT_SMTP_HOST: z.enum(['127.0.0.1', 'mailpit']).default('127.0.0.1'),
  MAIL_DELIVERY_DISABLED: z.enum(['false', 'true']).default('false'),
};

export class Mailpit {
  private readonly transport;

  constructor(
    port: number,
    private readonly source: 'tickets' | 'catalog',
    host = '127.0.0.1',
  ) {
    this.transport = createTransport({
      host,
      port,
      ignoreTLS: true,
      connectionTimeout: 3000,
      greetingTimeout: 3000,
      socketTimeout: 5000,
    });
  }

  async send(id: string, to: string, subject: string, text: string) {
    const result = await operation('mail.smtp', () =>
      this.transport.sendMail({
        from: 'EventFlow <hello@eventflow.test>',
        to: { name: '', address: to },
        subject,
        text,
        messageId: `<${this.source}-${id}@eventflow.test>`,
      }),
    );
    if (result.accepted.length !== 1) throw new Error('Message was not accepted');
    return 'SENT' as const;
  }
}

export class MailQueue {
  constructor(
    private readonly query: Query,
    private readonly transaction?: Transaction,
  ) {}

  async claim() {
    await this.query(
      `UPDATE "DeliveryJob" SET state = 'DEAD', lease = NULL
        WHERE state = 'PENDING' AND attempts >= $1 AND "nextRunAt" <= now()`,
      maxAttempts,
    );
    const [job] = await this.query<Job[]>(
      `WITH candidate AS (
         SELECT id FROM "DeliveryJob" WHERE state = 'PENDING' AND attempts < $1
           AND "nextRunAt" <= now() ORDER BY "nextRunAt", id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE "DeliveryJob" AS job
         SET lease = $2::uuid, attempts = job.attempts + 1, "nextRunAt" = now() + interval '60 seconds'
         FROM candidate WHERE job.id = candidate.id RETURNING job.id, job.lease, job.attempts, job.traceparent`,
      maxAttempts,
      randomUUID(),
    );
    return job;
  }

  async settle(job: Job, result?: 'SENT' | 'SKIPPED') {
    const delay = delays[job.attempts - 1];
    const state = result ?? (delay === undefined ? 'DEAD' : 'PENDING');
    await this.query(
      `UPDATE "DeliveryJob" SET state = $1, lease = NULL,
         "nextRunAt" = now() + $2 * interval '1 millisecond'
         WHERE id = $3::uuid AND lease = $4::uuid`,
      state,
      delay ?? 0,
      job.id,
      job.lease,
    );
  }

  dead() {
    return this.query<{ id: string; attempts: number }[]>(
      `SELECT id, attempts FROM "DeliveryJob" WHERE state = 'DEAD'
         ORDER BY "nextRunAt", id LIMIT 100`,
    );
  }

  async retry(
    id: string,
    requestId: string,
    actor: string,
    options: { reason?: string; version?: string; actorType?: 'HUMAN' | 'SERVICE' } = {},
  ) {
    if (!this.transaction)
      throw new ApiError(503, 'MAIL_RETRY_UNAVAILABLE', 'Повтор временно недоступен.');
    const reason = options.reason ?? null,
      expectedVersion = options.version ?? null,
      actorType = options.actorType ?? 'SERVICE';
    if (actorType === 'HUMAN' && (!reason || !expectedVersion))
      throw new ApiError(422, 'VERSION_REQUIRED', 'Нужны причина и актуальная версия записи.');
    await this.transaction(async (query) => {
      await query(
        'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,3))',
        requestId,
      );
      const [previous] = await query<
        {
          jobId: string;
          actorSubject: string;
          reason: string | null;
          expectedVersion: string | null;
          actorType: string | null;
        }[]
      >(
        'SELECT "jobId","actorSubject",reason,"expectedVersion","actorType" FROM "DeliveryRetry" WHERE "requestId"=$1::uuid',
        requestId,
      );
      if (previous) {
        if (
          previous.jobId !== id ||
          previous.actorSubject !== actor ||
          previous.reason !== reason ||
          previous.expectedVersion !== expectedVersion ||
          (previous.actorType ?? 'SERVICE') !== actorType
        )
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Ключ уже использован.');
        return;
      }
      const [job] = await query<
        {
          state: string;
          attempts: number;
          nextRunAt: Date;
          lease: string | null;
          recoveryKey: string | null;
          traceparent: string | null;
        }[]
      >(
        'SELECT state,attempts,"nextRunAt",lease,"recoveryKey",traceparent FROM "DeliveryJob" WHERE id=$1::uuid FOR UPDATE',
        id,
      );
      if (!job || job.state !== 'DEAD')
        throw new ApiError(409, 'DELIVERY_NOT_DEAD', 'Задача недоступна для повтора.');
      if (
        expectedVersion &&
        expectedVersion !==
          operationVersion(job.state, job.attempts, job.nextRunAt, job.lease, job.recoveryKey)
      )
        throw new ApiError(409, 'STALE_OPERATION', 'Запись изменилась. Обновите карточку.');
      linkTrace(job.traceparent);
      await query(
        'INSERT INTO "DeliveryRetry" ("requestId","jobId","actorSubject",reason,"expectedVersion","actorType",traceparent) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7)',
        requestId,
        id,
        actor,
        reason,
        expectedVersion,
        actorType,
        currentTraceparent() ?? null,
      );
      await query(
        'UPDATE "DeliveryJob" SET state=\'PENDING\',attempts=0,lease=NULL,"nextRunAt"=clock_timestamp(),"recoveryKey"=$2::uuid,traceparent=COALESCE($3,traceparent) WHERE id=$1::uuid',
        id,
        requestId,
        currentTraceparent() ?? null,
      );
    });
  }
}

export class MailWorker {
  private telemetry: Telemetry | undefined;
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly queue: MailQueue,
    private readonly send: Send,
    private readonly enabled = true,
  ) {}

  onModuleInit() {
    if (!this.enabled) return;
    this.telemetry = currentTelemetry();
    this.stopped = false;
    this.schedule();
  }

  private schedule() {
    if (!this.stopped)
      this.timer = setTimeout(() => {
        this.running = this.tick();
      }, 500);
  }

  private async tick() {
    try {
      const job = await this.queue.claim();
      if (!job) return;
      await observedJob(
        this.telemetry,
        'mail.delivery',
        async () => {
          const result = await this.send(job.id).catch(() => {
            traceFailure();
            return undefined;
          });
          await this.queue.settle(job, result);
          this.telemetry?.metrics?.delivery(
            result === 'SENT'
              ? 'sent'
              : result === 'SKIPPED'
                ? 'skipped'
                : job.attempts >= maxAttempts
                  ? 'dead'
                  : 'retry',
          );
          if (!result)
            console.warn(
              JSON.stringify({
                kind: 'mail_delivery_failed',
                jobId: job.id,
                attempt: job.attempts,
              }),
            );
        },
        { parent: job.traceparent, attempt: job.attempts - 1 },
      );
    } catch {
      this.telemetry?.metrics?.delivery('queue_error');
      console.warn(JSON.stringify({ kind: 'mail_queue_unavailable' }));
    } finally {
      this.schedule();
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}

@Controller('internal/mail')
export class MailOperator {
  constructor(
    @Inject(MailQueue) private readonly queue: MailQueue,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}

  @Get('dead')
  async dead(@Headers('authorization') auth: string | undefined) {
    await this.verifier.service(auth, 'eventflow-mail-operator', 'mail-retry');
    return { jobs: await this.queue.dead() };
  }

  @Post(':id/retry')
  @HttpCode(202)
  async retry(
    @Headers('authorization') auth: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.verifier.service(auth, 'eventflow-mail-operator', 'mail-retry');
    parseInput(z.strictObject({}), body ?? {});
    await this.queue.retry(
      parseInput(z.uuid(), id).toLowerCase(),
      parseInput(z.uuid(), key).toLowerCase(),
      actor.subject,
    );
    return { accepted: true };
  }
}
