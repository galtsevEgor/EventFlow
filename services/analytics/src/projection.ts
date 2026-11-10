import { randomUUID } from 'node:crypto';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ClickHouse, type JournalRow } from './clickhouse';
import { Journal } from './journal';

const ANALYTICS_PROJECTION_LOCK = 180020;
const ANALYTICS_SYNC_INTERVAL_MS = 1_000;

export class AnalyticsProjection {
  constructor(
    readonly journal: Journal,
    readonly engine: ClickHouse,
  ) {}
  private async replay(
    after: string,
    through: string,
    apply: (rows: JournalRow[], sequence: string) => Promise<void>,
  ) {
    let cursor = after;
    for (;;) {
      const rows = await this.journal.rows(cursor, through);
      const last = rows.at(-1);
      if (!last) return cursor;
      await apply(rows, last.sequence);
      cursor = last.sequence;
    }
  }
  async sync() {
    return this.journal.lock(ANALYTICS_PROJECTION_LOCK, async (client) => {
      await this.engine.initialize();
      const generation = await this.engine.generation();
      const previous = await this.journal.checkpoint(client);
      const start = previous?.generation === generation ? previous.sequence : '0';
      const through = await this.journal.highWater();
      const after = await this.replay(start, through, async (rows, sequence) => {
        await this.engine.insert(rows);
        // This physical connection owns the advisory lock. A disconnected writer cannot advance it.
        await this.journal.save(client, generation, sequence);
      });
      await this.journal.save(client, generation, after);
      return { sequence: after, generation };
    });
  }
  async rebuild() {
    return this.journal.lock(ANALYTICS_PROJECTION_LOCK, async (client) => {
      await this.engine.initialize();
      const name = 'build_' + randomUUID().replaceAll('-', '');
      await this.engine.initialize(name);
      try {
        const through = await this.journal.highWater();
        const after = await this.replay('0', through, (rows) => this.engine.insert(rows, name));
        // Atomic swaps preserve the old queryable generation throughout replay.
        await this.engine.command(
          `EXCHANGE TABLES ${this.engine.table()} AND ${this.engine.table(name)}`,
        );
        const generation = await this.engine.generation();
        await this.journal.save(client, generation, after);
        return { sequence: after, generation };
      } finally {
        await this.engine
          .command('DROP TABLE IF EXISTS ' + this.engine.table(name) + ' SYNC')
          .catch(() => {});
      }
    });
  }
  async status() {
    const [checkpoint, generation] = await Promise.all([
      this.journal.checkpoint(),
      this.engine.generation(),
    ]);
    if (!checkpoint || checkpoint.generation !== generation)
      throw new Error('Analytics projection recovering');
    const pending = await this.journal.pending(checkpoint.sequence);
    return {
      sequence: checkpoint.sequence,
      pending,
      updatedAt: checkpoint.updated_at.toISOString(),
      stale: pending > 0,
    };
  }
}
export class AnalyticsWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private active?: Promise<void>;
  constructor(private readonly projection: AnalyticsProjection) {}
  onModuleInit() {
    this.schedule(0);
  }
  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      this.active = this.projection
        .sync()
        .then(() => {})
        .catch(() => {})
        .finally(() => {
          if (!this.stopped) this.schedule(ANALYTICS_SYNC_INTERVAL_MS);
        });
    }, delay);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
}
