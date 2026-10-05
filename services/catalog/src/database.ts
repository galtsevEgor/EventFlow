import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from './generated/client';
import { Pool } from 'pg';
import { currentTelemetry, type Metrics } from '@eventflow/telemetry';
import { observeDatabase } from '@eventflow/service-runtime';

export class Database extends PrismaClient<
  Prisma.PrismaClientOptions & { log: [{ emit: 'event'; level: 'query' }] }
> {
  private readonly pool: Pool;
  private metrics: Metrics | undefined;
  private removeMetrics: (() => void) | undefined;
  constructor(connectionString: string, max = 12) {
    const pool = new Pool({
      connectionString,
      max,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    super({
      adapter: new PrismaPg(pool, { disposeExternalPool: true }),
      log: [{ emit: 'event', level: 'query' }],
      transactionOptions: { maxWait: 5000, timeout: 10000 },
    });
    this.pool = pool;
    this.$on('query', (event) => this.metrics?.query(event.duration));
  }
  async onModuleInit() {
    await this.$connect();
    this.metrics = currentTelemetry()?.metrics;
    this.removeMetrics = observeDatabase(
      'catalog',
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
