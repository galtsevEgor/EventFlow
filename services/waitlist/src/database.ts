import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { message, type EventEnvelope } from '@eventflow/event-contracts';
export type Entry = {
  id: string;
  sequence: string;
  sale_id: string;
  buyer_subject: string;
  category_id: string;
  contact: Buffer;
  state: string;
  cancel_reason: string;
  attempt_id: string | null;
  order_id: string | null;
  expires_at: Date | null;
  version: number;
  created_at: Date;
};
export type Query = <T extends QueryResultRow>(sql: string, ...values: unknown[]) => Promise<T[]>;
export class Database {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 3000 });
    this.pool.on('error', () => {
      /* Failed idle connections are replaced on the next operation. */
    });
  }
  query: Query = async (sql, ...values) => (await this.pool.query(sql, values)).rows;
  async transaction<T>(run: (q: Query) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await run(this.executor(c));
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  executor(c: PoolClient): Query {
    return async (sql, ...values) => (await c.query(sql, values)).rows;
  }
  async wake(q: Query, saleId: string) {
    await q(
      'INSERT INTO workflow_dispatch(sale_id) VALUES ($1) ON CONFLICT (sale_id) DO UPDATE SET revision=workflow_dispatch.revision+1',
      saleId,
    );
  }
  async changed(q: Query, entry: Entry) {
    const [event] = await q<{ organization_id: string }>(
      'SELECT organization_id FROM waitlist_event WHERE sale_id=$1',
      entry.sale_id,
    );
    if (!event) throw new Error('Waitlist event missing');
    const envelope: EventEnvelope = message(
      'waitlist',
      'WaitlistChanged.v1',
      entry.id,
      entry.version,
      {
        entryId: entry.id,
        saleId: entry.sale_id,
        organizationId: event.organization_id,
        state: entry.state,
        orderId: entry.order_id,
        occurredAt: new Date().toISOString(),
      },
    );
    await q('INSERT INTO "Outbox"(id,envelope) VALUES ($1,$2)', envelope.eventId, envelope);
    await this.wake(q, entry.sale_id);
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
