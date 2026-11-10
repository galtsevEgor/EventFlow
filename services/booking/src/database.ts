import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { currentTelemetry, type Metrics } from '@eventflow/telemetry';
import {
  observeDatabase,
  prismaPostgresDefaults,
  snapshotPostgresPool,
} from '@eventflow/service-runtime';
import { PrismaClient, type Prisma } from './generated/client';

const slowQueryThresholdMs = 100;

export class Database extends PrismaClient<
  Prisma.PrismaClientOptions & {
    log: [{ emit: 'event'; level: 'query' }];
  }
> {
  private readonly pool: Pool;
  private metrics: Metrics | undefined;
  private removeMetrics: (() => void) | undefined;
  private queries = { count: 0, slow: 0, maxMs: 0 };
  constructor(connectionString: string, max: number = prismaPostgresDefaults.poolSize.booking) {
    const pool = new Pool({
      connectionString,
      max,
      ...prismaPostgresDefaults.pool,
      application_name: 'eventflow-booking',
    });
    super({
      adapter: new PrismaPg(pool, { disposeExternalPool: true }),
      log: [{ emit: 'event', level: 'query' }],
      transactionOptions: prismaPostgresDefaults.transaction,
    });
    this.pool = pool;
    this.$on('query', (event) => {
      this.metrics?.query(event.duration);
      this.queries.count++;
      if (event.duration >= slowQueryThresholdMs) this.queries.slow++;
      this.queries.maxMs = Math.max(this.queries.maxMs, event.duration);
    });
  }
  diagnostics() {
    // SQL text, parameters, identities and credentials never leave the client.
    return {
      pool: snapshotPostgresPool(this.pool),
      queries: { ...this.queries, slowThresholdMs: slowQueryThresholdMs },
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
      () => snapshotPostgresPool(this.pool),
    );
  }
  async onApplicationShutdown() {
    this.removeMetrics?.();
    this.metrics = undefined;
    await this.$disconnect();
  }
}
