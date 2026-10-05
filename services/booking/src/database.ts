import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { currentTelemetry, type Metrics } from '@eventflow/telemetry';
import { observeDatabase } from '@eventflow/service-runtime';
import { PrismaClient, type Prisma } from './generated/client';

export class Database extends PrismaClient<
  Prisma.PrismaClientOptions & {
    log: [{ emit: 'event'; level: 'query' }];
  }
> {
  private readonly pool: Pool;
  private metrics: Metrics | undefined;
  private removeMetrics: (() => void) | undefined;
  private queries = { count: 0, slow: 0, maxMs: 0 };
  constructor(connectionString: string, max = 12) {
    const pool = new Pool({
      connectionString,
      max,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
      application_name: 'eventflow-booking',
    });
    super({
      adapter: new PrismaPg(pool, { disposeExternalPool: true }),
      log: [{ emit: 'event', level: 'query' }],
      transactionOptions: { maxWait: 5000, timeout: 10000 },
    });
    this.pool = pool;
    this.$on('query', (event) => {
      this.metrics?.query(event.duration);
      this.queries.count++;
      if (event.duration >= 100) this.queries.slow++;
      this.queries.maxMs = Math.max(this.queries.maxMs, event.duration);
    });
  }
  diagnostics() {
    // SQL text, parameters, identities and credentials never leave the client.
    return {
      pool: {
        limit: this.pool.options.max,
        total: this.pool.totalCount,
        idle: this.pool.idleCount,
        waiting: this.pool.waitingCount,
      },
      queries: { ...this.queries, slowThresholdMs: 100 },
    };
  }
  resetQueryMetrics() {
    this.queries = { count: 0, slow: 0, maxMs: 0 };
  }
  async onModuleInit() {
    await this.$connect();
    this.metrics = currentTelemetry()?.metrics;
    this.removeMetrics = observeDatabase(
      'booking',
      (sql) => this.$queryRawUnsafe(sql),
      () => ({
        limit: this.pool.options.max,
        total: this.pool.totalCount,
        idle: this.pool.idleCount,
        waiting: this.pool.waitingCount,
      }),
    );
  }
  async onApplicationShutdown() {
    this.removeMetrics?.();
    this.metrics = undefined;
    await this.$disconnect();
  }
}
