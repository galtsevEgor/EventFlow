import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient, type Prisma } from './generated/client';

export class Database extends PrismaClient<
  Prisma.PrismaClientOptions & {
    log: [{ emit: 'event'; level: 'query' }];
  }
> {
  private readonly pool: Pool;
  private queries = { count: 0, slow: 0, maxMs: 0 };
  constructor(connectionString: string) {
    const pool = new Pool({
      connectionString,
      max: 12,
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
      this.queries.count++;
      if (event.duration >= 100) this.queries.slow++;
      this.queries.maxMs = Math.max(this.queries.maxMs, event.duration);
    });
  }
  diagnostics() {
    // SQL text, parameters, identities and credentials never leave the client.
    return {
      pool: {
        limit: 12,
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
  }
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}
