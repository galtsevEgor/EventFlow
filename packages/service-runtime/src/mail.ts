import { randomUUID } from 'node:crypto';
import { ApiError } from './http';
import { operationVersion } from './operator-page';
import {
  currentTelemetry,
  observedJob,
  traceFailure,
  currentTraceparent,
  linkTrace,
  type Telemetry,
} from '@eventflow/telemetry';

const retryDelaysMs = [5_000, 30_000, 120_000];
const maxAttempts = retryDelaysMs.length + 1;
const jobLeaseSeconds = 60;
const deadJobListLimit = 100;
const workerPollIntervalMs = 500;
type Query = <T>(sql: string, ...values: unknown[]) => Promise<T>;
type Transaction = <T>(operation: (query: Query) => Promise<T>) => Promise<T>;
type Job = { id: string; lease: string; attempts: number; traceparent: string | null };
type Send = (id: string) => Promise<'SENT' | 'SKIPPED'>;

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
         SET lease = $2::uuid, attempts = job.attempts + 1, "nextRunAt" = now() + $3::int * interval '1 second'
         FROM candidate WHERE job.id = candidate.id RETURNING job.id, job.lease, job.attempts, job.traceparent`,
      maxAttempts,
      randomUUID(),
      jobLeaseSeconds,
    );
    return job;
  }

  async settle(job: Job, result?: 'SENT' | 'SKIPPED') {
    const delay = retryDelaysMs[job.attempts - 1];
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
         ORDER BY "nextRunAt", id LIMIT $1::int`,
      deadJobListLimit,
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
      }, workerPollIntervalMs);
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
