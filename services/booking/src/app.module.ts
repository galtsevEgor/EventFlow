import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, Readiness, TokenVerifier } from '@eventflow/service-runtime';
import { Broker, Outbox, MessageWorker } from '@eventflow/messaging';
import { commerceRoutes } from '@eventflow/event-contracts';
import { Database } from './database';
import { ProvisionSale } from './provision';
import { ChangeAvailability } from './availability';
import { SaleReader } from './sale-reader';
import { SaleController } from './sale.controller';
import type { BookingConfig } from './config';
import { Reserve } from './orders/reserve';
import { OrderReader } from './orders/reader';
import { OrderController } from './orders/controller';
import { OrderLifecycle } from './orders/lifecycle';
import { OrderSweeper } from './orders/sweeper';
import { PaymentAuthorization } from './payments/authorization';
import { BookingPaymentsController } from './payments/controller';
import { ConfirmPayment } from './payments/confirm';
import { RefundOutcome } from './payments/refund-outcome';

@Module({ imports: [HealthModule.forService('booking')] })
export class AppModule {
  static configure(config: BookingConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [SaleController, OrderController, BookingPaymentsController],
      providers: [
        {
          provide: PaymentAuthorization,
          inject: [Database],
          useFactory: (db: Database) => new PaymentAuthorization(db),
        },
        {
          provide: ConfirmPayment,
          inject: [Database],
          useFactory: (db: Database) => new ConfirmPayment(db),
        },
        {
          provide: OrderLifecycle,
          inject: [Database],
          useFactory: (db: Database) => new OrderLifecycle(db),
        },
        {
          provide: OrderSweeper,
          inject: [Database, OrderLifecycle],
          useFactory: (db: Database, lifecycle: OrderLifecycle) => new OrderSweeper(db, lifecycle),
        },
        {
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-booking'),
        },
        { provide: Reserve, inject: [Database], useFactory: (db: Database) => new Reserve(db) },
        {
          provide: OrderReader,
          inject: [Database],
          useFactory: (db: Database) => new OrderReader(db),
        },
        {
          provide: SaleReader,
          inject: [Database],
          useFactory: (db: Database) => new SaleReader(db),
        },
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
                routes: commerceRoutes,
              }),
              new Outbox((sql, ...values) => db.$queryRawUnsafe(sql, ...values)),
              (event) =>
                event.eventType.startsWith('Refund')
                  ? new RefundOutcome(db).handle(event)
                  : event.eventType === 'PaymentSucceeded.v1'
                    ? new ConfirmPayment(db).handle(event)
                    : event.eventType === 'SaleAvailabilityRequested.v1'
                      ? new ChangeAvailability(db).handle(event)
                      : provision.handle(event),
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
