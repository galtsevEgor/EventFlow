import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@eventflow/event-contracts';

const leaseSeconds = 30;
const retryBaseMs = 500;
const retryCapMs = 60_000;
const retryMaxExponent = 7;
const retryJitterMs = 500;

export type SqlExecutor = <T>(sql: string, ...values: unknown[]) => Promise<T>;
export class Outbox {
  constructor(private readonly query: SqlExecutor) {}
  async claim() {
    const lease = randomUUID();
    const rows = await this.query<{ id: string; envelope: EventEnvelope; attempts: number }[]>(
      `UPDATE "Outbox" SET "lease" = $1::uuid, "availableAt" = clock_timestamp() + $2::int * interval '1 second', "attempts" = "attempts" + 1
       WHERE "id" = (SELECT "id" FROM "Outbox" WHERE "sentAt" IS NULL AND "availableAt" <= clock_timestamp()
         ORDER BY "availableAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING "id", "envelope", "attempts"`,
      lease,
      leaseSeconds,
    );
    return rows[0] ? { ...rows[0], lease } : null;
  }
  async settle(id: string, lease: string, sent: boolean, attempts: number) {
    const delay =
      Math.min(retryCapMs, retryBaseMs * 2 ** Math.min(attempts, retryMaxExponent)) +
      Math.floor(Math.random() * retryJitterMs);
    await this.query(
      `UPDATE "Outbox" SET "sentAt" = CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
       "lease" = NULL, "availableAt" = clock_timestamp() + $4 * interval '1 millisecond'
       WHERE "id" = $1::uuid AND "lease" = $2::uuid`,
      id,
      lease,
      sent,
      delay,
    );
  }
}
