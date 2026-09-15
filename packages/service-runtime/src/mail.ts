import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { z } from 'zod';
import { ApiError, parseInput } from './http';
import { TokenVerifier } from './identity';

const delays = [5000, 30_000, 120_000];
const maxAttempts = delays.length + 1;
type Query = <T>(sql: string, ...values: unknown[]) => Promise<T>;
type Job = { id: string; lease: string; attempts: number };
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
    const result = await this.transport.sendMail({
      from: 'EventFlow <hello@eventflow.test>',
      to: { name: '', address: to },
      subject,
      text,
      messageId: `<${this.source}-${id}@eventflow.test>`,
    });
    if (result.accepted.length !== 1) throw new Error('Message was not accepted');
    return 'SENT' as const;
  }
}

export class MailQueue {
  constructor(private readonly query: Query) {}

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
         FROM candidate WHERE job.id = candidate.id RETURNING job.id, job.lease, job.attempts`,
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

  async retry(id: string, requestId: string, actor: string) {
    const [result] = await this.query<{ jobId: string; actorSubject: string }[]>(
      `WITH candidate AS (
         SELECT id FROM "DeliveryJob" WHERE id = $1::uuid AND state = 'DEAD' FOR UPDATE
       ), audit AS (
         INSERT INTO "DeliveryRetry" ("requestId", "jobId", "actorSubject")
           SELECT $2::uuid, id, $3 FROM candidate
           ON CONFLICT ("requestId") DO NOTHING RETURNING "jobId", "actorSubject"
       ), retried AS (
         UPDATE "DeliveryJob" SET state = 'PENDING', attempts = 0, lease = NULL, "nextRunAt" = now()
           WHERE id IN (SELECT "jobId" FROM audit)
       )
       SELECT * FROM audit UNION ALL
       SELECT "jobId", "actorSubject" FROM "DeliveryRetry" WHERE "requestId" = $2::uuid`,
      id,
      requestId,
      actor,
    );
    if (!result) throw new ApiError(409, 'DELIVERY_NOT_DEAD', 'Задача недоступна для повтора.');
    if (result.jobId !== id || result.actorSubject !== actor)
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Ключ уже использован.');
  }
}

export class MailWorker {
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
      const result = await this.send(job.id).catch(() => undefined);
      await this.queue.settle(job, result);
      if (!result)
        console.warn(
          JSON.stringify({ kind: 'mail_delivery_failed', jobId: job.id, attempt: job.attempts }),
        );
    } catch {
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
