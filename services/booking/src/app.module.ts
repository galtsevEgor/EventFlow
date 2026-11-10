import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, Readiness, SecretBox, TokenVerifier } from '@eventflow/service-runtime';
import { Database } from './database';
import { ProvisionSale } from './provision';
import { SaleReader } from './sale-reader';
import { SaleController } from './sale.controller';
import type { BookingConfig } from './config';
import { Reserve } from './orders/reserve';
import { WaitlistReservationsController } from './orders/waitlist.controller';
import { OrderReader } from './orders/reader';
import { OrderController } from './orders/controller';
import { DeliveryContextController } from './orders/delivery.controller';
import { OrderLifecycle } from './orders/lifecycle';
import { PaymentAuthorization } from './payments/authorization';
import { BookingPaymentsController } from './payments/controller';
import { ConfirmPayment } from './payments/confirm';
import { RefundAccess } from './refunds/access';
import { OrganizerRefunds } from './refunds/organizer';
import { OrganizerOrdersController, OrderUpdatesAccessController } from './refunds/controller';
import { BookingOps } from './ops.controller';

import { bookingBrokerReadiness, bookingWorkerProviders } from './worker-providers';

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
              WaitlistReservationsController,
              BookingPaymentsController,
              DeliveryContextController,
              OrganizerOrdersController,
              OrderUpdatesAccessController,
              BookingOps,
            ],
      providers: [
        { provide: RefundAccess, useFactory: () => new RefundAccess(config) },
        {
          provide: OrganizerRefunds,
          inject: [Database, RefundAccess],
          useFactory: (db: Database, access: RefundAccess) => new OrganizerRefunds(db, access),
        },
        ...(runWorkers ? bookingWorkerProviders(config) : []),
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
        ...(config.EVENTFLOW_WORKLOAD === 'worker' ? [bookingBrokerReadiness] : []),
      ],
    };
  }
}
