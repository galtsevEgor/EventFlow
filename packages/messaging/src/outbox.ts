import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@eventflow/event-contracts';

export type SqlExecutor = <T>(sql: string, ...values: unknown[]) => Promise<T>;
export class Outbox {
  constructor(private readonly query: SqlExecutor) {}
  async claim() {
    const lease = randomUUID();
    const rows = await this.query<{ id: string; envelope: EventEnvelope; attempts: number }[]>(
      `UPDATE "Outbox" SET "lease" = $1::uuid, "availableAt" = clock_timestamp() + interval '30 seconds', "attempts" = "attempts" + 1
       WHERE "id" = (SELECT "id" FROM "Outbox" WHERE "sentAt" IS NULL AND "availableAt" <= clock_timestamp()
         ORDER BY "availableAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING "id", "envelope", "attempts"`,
      lease,
    );
    return rows[0] ? { ...rows[0], lease } : null;
  }
  async settle(id: string, lease: string, sent: boolean, attempts: number) {
    const delay =
      Math.min(60_000, 500 * 2 ** Math.min(attempts, 7)) + Math.floor(Math.random() * 500);
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
