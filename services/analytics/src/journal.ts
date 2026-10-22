import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { analyticsFactSchema, type AnalyticsFact } from '@eventflow/event-contracts';
import { ApiError } from '@eventflow/service-runtime';
import type { JournalRow } from './clickhouse';

export class Journal {
  readonly pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      max: 6,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    this.pool.on('error', () => {});
  }
  async append(input: AnalyticsFact[]) {
    const facts = input.map((fact) => analyticsFactSchema.parse(fact));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize sequence allocation and commits so a checkpoint cannot skip an uncommitted row.
      await client.query('SELECT pg_advisory_xact_lock(180010)');
      const rows = facts.map((fact) => ({
        key: fact.key,
        hash: createHash('sha256').update(JSON.stringify(fact)).digest('hex'),
        fact,
      }));
      if (rows.length) {
        await client.query(
          'INSERT INTO analytics_event (key,hash,fact) SELECT key,hash,fact FROM jsonb_to_recordset($1::jsonb) AS input(key text,hash text,fact jsonb) ON CONFLICT (key) DO NOTHING',
          [JSON.stringify(rows)],
        );
        const saved = await client.query<{ key: string; hash: string }>(
          'SELECT key,hash FROM analytics_event WHERE key=ANY($1::text[])',
          [rows.map((r) => r.key)],
        );
        const hashes = new Map(saved.rows.map((r) => [r.key, r.hash]));
        if (rows.some((row) => hashes.get(row.key) !== row.hash))
          throw new ApiError(409, 'ANALYTICS_CONFLICT', 'Событие уже записано с другими данными.');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async rows(after: string, through?: string): Promise<JournalRow[]> {
    return (
      await this.pool.query<JournalRow>(
        'SELECT sequence::text, fact FROM analytics_event WHERE sequence > $1 AND ($2::bigint IS NULL OR sequence <= $2) ORDER BY analytics_event.sequence LIMIT 1000',
        [after, through ?? null],
      )
    ).rows;
  }
  async highWater() {
    return (
      await this.pool.query<{ value: string }>(
        'SELECT coalesce(max(sequence),0)::text AS value FROM analytics_event',
      )
    ).rows[0]!.value;
  }
  async pending(after: string) {
    return Number(
      (
        await this.pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM analytics_event WHERE sequence>$1',
          [after],
        )
      ).rows[0]!.count,
    );
  }
  async checkpoint(client?: PoolClient) {
    return (
      (
        await (client ?? this.pool).query<{
          generation: string;
          sequence: string;
          updated_at: Date;
        }>('SELECT generation, sequence::text, updated_at FROM analytics_checkpoint WHERE id=1')
      ).rows[0] ?? null
    );
  }
  async save(client: PoolClient, generation: string, sequence: string) {
    await client.query(
      'INSERT INTO analytics_checkpoint (id,generation,sequence) VALUES (1,$1,$2) ON CONFLICT (id) DO UPDATE SET generation=$1,sequence=$2,updated_at=clock_timestamp()',
      [generation, sequence],
    );
  }
  async lock<T>(key: number, action: (client: PoolClient) => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    let locked = false;
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on('error', onError);
    try {
      locked = (
        await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key])
      ).rows[0]!.locked;
      return locked ? await action(client) : null;
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [key]);
        } catch {
          broken = true;
        }
      }
      client.removeListener('error', onError);
      client.release(broken);
    }
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
