import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from './generated/client';
import { Pool } from 'pg';
import { currentTelemetry, type Metrics } from '@eventflow/telemetry';
import {
  observeDatabase,
  prismaPostgresDefaults,
  snapshotPostgresPool,
} from '@eventflow/service-runtime';

export class Database extends PrismaClient<
  Prisma.PrismaClientOptions & { log: [{ emit: 'event'; level: 'query' }] }
> {
  private readonly pool: Pool;
  private metrics: Metrics | undefined;
  private removeMetrics: (() => void) | undefined;
  constructor(connectionString: string, max: number = prismaPostgresDefaults.poolSize.tickets) {
    const pool = new Pool({
      connectionString,
      max,
      ...prismaPostgresDefaults.pool,
      application_name: 'eventflow-tickets',
    });
    super({
      adapter: new PrismaPg(pool, { disposeExternalPool: true }),
      log: [{ emit: 'event', level: 'query' }],
      transactionOptions: prismaPostgresDefaults.transaction,
    });
    this.pool = pool;
    this.$on('query', (event) => this.metrics?.query(event.duration));
  }
  async onModuleInit() {
    await this.$connect();
    this.metrics = currentTelemetry()?.metrics;
    this.removeMetrics = observeDatabase(
      'tickets',
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
