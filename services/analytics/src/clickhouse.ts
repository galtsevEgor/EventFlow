import type { AnalyticsConfig } from './config';
import type { AnalyticsFact } from '@eventflow/event-contracts';
export type JournalRow = { sequence: string; fact: AnalyticsFact };
export class ClickHouse {
  readonly database: string;
  constructor(
    readonly config: Pick<
      AnalyticsConfig,
      'CLICKHOUSE_URL' | 'CLICKHOUSE_USER' | 'CLICKHOUSE_PASSWORD' | 'ANALYTICS_DATABASE'
    >,
  ) {
    this.database = config.ANALYTICS_DATABASE;
  }
  table(name = 'events') {
    if (!/^(events|build_[a-f0-9]{32})$/.test(name)) throw new Error('Invalid analytics table');
    return `${this.database}.${name}`;
  }
  async command(sql: string, params: Record<string, string> = {}) {
    const url = new URL(this.config.CLICKHOUSE_URL);
    url.searchParams.set('wait_end_of_query', '1');
    url.searchParams.set('max_execution_time', '10');
    url.searchParams.set('max_threads', '2');
    url.searchParams.set('max_memory_usage', '268435456');
    for (const [key, value] of Object.entries(params)) url.searchParams.set('param_' + key, value);
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'x-clickhouse-user': this.config.CLICKHOUSE_USER,
        'x-clickhouse-key': this.config.CLICKHOUSE_PASSWORD,
      },
      body: sql,
    });
    const body = await response.text();
    if (!response.ok || response.headers.has('x-clickhouse-exception-code'))
      throw new Error('ClickHouse query failed: ' + response.status);
    return body;
  }
  async rows<T>(sql: string, params: Record<string, string> = {}): Promise<T[]> {
    return JSON.parse(await this.command(sql + ' FORMAT JSON', params)).data as T[];
  }
  async initialize(name = 'events') {
    await this.command(`CREATE DATABASE IF NOT EXISTS ${this.database} ENGINE = Atomic`);
    await this.command(`CREATE TABLE IF NOT EXISTS ${this.table(name)} (
      key String, sequence UInt64, kind LowCardinality(String),
      organizationId String, eventId String, sessionId String, orderId String, searchId String,
      occurredAt DateTime64(3, 'UTC'), source LowCardinality(String), resultCount UInt32, limited UInt8
    ) ENGINE = ReplacingMergeTree(sequence)
    PARTITION BY toYYYYMM(occurredAt) ORDER BY (organizationId, eventId, key)`);
    await this.command(
      `ALTER TABLE ${this.table(name)} ADD COLUMN IF NOT EXISTS waitlistEntryId String DEFAULT ''`,
    );
  }
  async generation() {
    const rows = await this.rows<{ uuid: string }>(
      "SELECT toString(uuid) AS uuid FROM system.tables WHERE database={db:String} AND name='events'",
      { db: this.database },
    );
    if (!rows[0]) throw new Error('Analytics table missing');
    return rows[0].uuid;
  }
  async insert(rows: JournalRow[], name = 'events') {
    if (!rows.length) return;
    const data = rows
      .map(({ sequence, fact }) =>
        JSON.stringify({
          ...fact,
          sequence,
          occurredAt: fact.occurredAt.replace('T', ' ').replace('Z', ''),
          organizationId: fact.organizationId ?? '',
          eventId: fact.eventId ?? '',
          sessionId: fact.sessionId ?? '',
          orderId: fact.orderId ?? '',
          searchId: fact.searchId ?? '',
          limited: Number(fact.limited),
        }),
      )
      .join('\n');
    await this.command(`INSERT INTO ${this.table(name)} FORMAT JSONEachRow\n${data}`);
  }
}
