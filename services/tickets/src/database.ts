import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

export class Database extends PrismaClient {
  constructor(connectionString: string, max = 10) {
    super({
      adapter: new PrismaPg({
        connectionString,
        max,
        connectionTimeoutMillis: 3000,
        statement_timeout: 5000,
        application_name: 'eventflow-tickets',
      }),
      transactionOptions: { maxWait: 5000, timeout: 10000 },
    });
  }
  async onModuleInit() {
    await this.$connect();
  }
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}
