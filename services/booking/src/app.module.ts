import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, Readiness, SecretBox, TokenVerifier } from '@eventflow/service-runtime';
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
import { DeliveryContextController } from './orders/delivery.controller';
import { OrderLifecycle } from './orders/lifecycle';
import { OrderSweeper } from './orders/sweeper';
import { PaymentAuthorization } from './payments/authorization';
import { BookingPaymentsController } from './payments/controller';
import { ConfirmPayment } from './payments/confirm';
import { RefundOutcome } from './payments/refund-outcome';
import { RefundAccess } from './refunds/access';
import { OrganizerRefunds } from './refunds/organizer';
import { OrganizerOrdersController, OrderUpdatesAccessController } from './refunds/controller';
import { RefundWorkflow } from './refunds/workflow';

@Module({ imports: [HealthModule.forService('booking')] })
export class AppModule {
  static configure(config: BookingConfig): DynamicModule {
    const runWorkers = config.EVENTFLOW_WORKLOAD !== 'http';
    return {
      module: AppModule,
      controllers:
        config.EVENTFLOW_WORKLOAD === 'worker'
          ? []
          : [
              SaleController,
              OrderController,
              BookingPaymentsController,
              DeliveryContextController,
              OrganizerOrdersController,
              OrderUpdatesAccessController,
            ],
      providers: [
        { provide: RefundAccess, useFactory: () => new RefundAccess(config) },
        {
          provide: OrganizerRefunds,
          inject: [Database, RefundAccess],
          useFactory: (db: Database, access: RefundAccess) => new OrganizerRefunds(db, access),
        },
        ...(runWorkers
          ? [
              {
                provide: 'BOOKING_REFUNDS_WORKER',
                inject: [Database],
                useFactory: (db: Database) =>
                  new MessageWorker(
                    new Broker({
                      url: config.AMQP_URL,
                      namespace: config.MESSAGE_NAMESPACE,
                      consumer: 'booking-refunds',
                      routes: commerceRoutes,
                    }),
                    undefined,
                    (event) => new RefundWorkflow(db).handle(event),
                  ),
              },
              {
                provide: OrderSweeper,
                inject: [Database, OrderLifecycle],
                useFactory: (db: Database, lifecycle: OrderLifecycle) =>
                  new OrderSweeper(db, lifecycle),
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
            ]
          : []),
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
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-booking'),
        },
        { provide: SecretBox, useFactory: () => new SecretBox(config.BOOKING_CONTACT_KEY) },
        {
          provide: Reserve,
          inject: [Database, SecretBox],
          useFactory: (db: Database, contact: SecretBox) => new Reserve(db, contact),
        },
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
        {
          provide: Database,
          useFactory: () => new Database(config.BOOKING_DATABASE_URL, config.DATABASE_POOL_SIZE),
        },
        {
          provide: ProvisionSale,
          inject: [Database],
          useFactory: (db: Database) => new ProvisionSale(db),
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
        ...(config.EVENTFLOW_WORKLOAD === 'worker'
          ? [
              {
                provide: 'BROKER_READINESS',
                inject: [Readiness, MessageWorker, 'BOOKING_REFUNDS_WORKER'],
                useFactory: (
                  readiness: Readiness,
                  worker: MessageWorker,
                  refunds: MessageWorker,
                ) => {
                  readiness.register('rabbitmq', async () => {
                    if (!worker.broker.ready || !refunds.broker.ready)
                      throw new Error('RabbitMQ consumer unavailable');
                  });
                  return readiness;
                },
              },
            ]
          : []),
      ],
    };
  }
}
