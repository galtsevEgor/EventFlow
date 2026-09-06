import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, Readiness } from '@eventflow/service-runtime';
import { Broker, Outbox, MessageWorker } from '@eventflow/messaging';
import { saleRoutes } from '@eventflow/event-contracts';
import { Database } from './database';
import { ProvisionSale } from './provision';
import type { BookingConfig } from './config';

@Module({ imports: [HealthModule.forService('booking')] })
export class AppModule {
  static configure(config: BookingConfig): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: Database, useFactory: () => new Database(config.BOOKING_DATABASE_URL) },
        {
          provide: ProvisionSale,
          inject: [Database],
          useFactory: (db: Database) => new ProvisionSale(db),
        },
        {
          provide: MessageWorker,
          inject: [Database, ProvisionSale],
          useFactory: (db: Database, provision: ProvisionSale) =>
            new MessageWorker(
              new Broker({
                url: config.AMQP_URL,
                namespace: config.MESSAGE_NAMESPACE,
                consumer: 'booking',
                routes: saleRoutes,
              }),
              new Outbox((sql, ...values) => db.$queryRawUnsafe(sql, ...values)),
              (event) => provision.handle(event),
            ),
        },
        {
          provide: 'BOOKING_READINESS',
          inject: [Readiness, Database],
          useFactory: (readiness: Readiness, db: Database) => {
            readiness.register('postgres', () =>
              db.sale.count({ where: { id: '00000000-0000-0000-0000-000000000000' } }),
            );
            return readiness;
          },
        },
      ],
    };
  }
}
