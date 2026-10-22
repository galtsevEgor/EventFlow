import { randomUUID } from 'node:crypto';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ClickHouse } from './clickhouse';
import { Journal } from './journal';

export class AnalyticsProjection {
  constructor(
    readonly journal: Journal,
    readonly engine: ClickHouse,
  ) {}
  async sync() {
    return this.journal.lock(180020, async (client) => {
      await this.engine.initialize();
      const generation = await this.engine.generation();
      const previous = await this.journal.checkpoint(client);
      let after = previous?.generation === generation ? previous.sequence : '0';
      const through = await this.journal.highWater();
      for (;;) {
        const rows = await this.journal.rows(after, through);
        if (!rows.length) break;
        await this.engine.insert(rows);
        after = rows.at(-1)!.sequence;
        // This physical connection owns the advisory lock. A disconnected writer cannot advance it.
        await this.journal.save(client, generation, after);
      }
      await this.journal.save(client, generation, after);
      return { sequence: after, generation };
    });
  }
  async rebuild() {
    return this.journal.lock(180020, async (client) => {
      await this.engine.initialize();
      const name = 'build_' + randomUUID().replaceAll('-', '');
      await this.engine.initialize(name);
      try {
        const through = await this.journal.highWater();
        let after = '0';
        for (;;) {
          const rows = await this.journal.rows(after, through);
          if (!rows.length) break;
          await this.engine.insert(rows, name);
          after = rows.at(-1)!.sequence;
        }
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
    const [checkpoint, highWater, generation] = await Promise.all([
      this.journal.checkpoint(),
      this.journal.highWater(),
      this.engine.generation(),
    ]);
    if (!checkpoint || checkpoint.generation !== generation)
      throw new Error('Analytics projection recovering');
    return {
      sequence: checkpoint.sequence,
      pending: Number(BigInt(highWater) - BigInt(checkpoint.sequence)),
      updatedAt: checkpoint.updated_at.toISOString(),
      stale: highWater !== checkpoint.sequence,
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
          if (!this.stopped) this.schedule(1000);
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
