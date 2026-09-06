import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, Readiness, TokenVerifier } from '@eventflow/service-runtime';
import { Broker, MessageWorker, Outbox } from '@eventflow/messaging';
import { commerceRoutes } from '@eventflow/event-contracts';
import { Database } from './database';
import { FakePaymentProvider } from './providers/fake';
import type { PaymentProvider } from './providers/provider';
import type { PaymentsConfig } from './config';
import { BookingClient } from './booking-client';
import { CreateAttempt } from './attempts/create';
import { ProcessAttempt } from './attempts/process';
import { ReadPayment } from './attempts/read';
import { PaymentController } from './controller';
import { PaymentInbox } from './inbox';
import { Reconciler } from './reconciler';

@Module({ imports: [HealthModule.forService('payments')] })
export class AppModule {
  static configure(config: PaymentsConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [PaymentController],
      providers: [
        { provide: Database, useFactory: () => new Database(config.PAYMENTS_DATABASE_URL) },
        {
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-payments'),
        },
        { provide: BookingClient, useFactory: () => new BookingClient(config) },
        {
          provide: 'PAYMENT_PROVIDER',
          inject: [Database],
          useFactory: (db: Database) => new FakePaymentProvider(db),
        },
        {
          provide: CreateAttempt,
          inject: [Database, BookingClient, 'PAYMENT_PROVIDER'],
          useFactory: (db: Database, booking: BookingClient, provider: PaymentProvider) =>
            new CreateAttempt(db, booking, provider),
        },
        {
          provide: ProcessAttempt,
          inject: [Database, BookingClient, 'PAYMENT_PROVIDER'],
          useFactory: (db: Database, booking: BookingClient, provider: PaymentProvider) =>
            new ProcessAttempt(db, booking, provider),
        },
        {
          provide: ReadPayment,
          inject: [Database, BookingClient, 'PAYMENT_PROVIDER', ProcessAttempt],
          useFactory: (
            db: Database,
            booking: BookingClient,
            provider: PaymentProvider,
            processor: ProcessAttempt,
          ) => new ReadPayment(db, booking, provider, processor),
        },
        {
          provide: PaymentInbox,
          inject: [Database],
          useFactory: (db: Database) => new PaymentInbox(db),
        },
        {
          provide: Reconciler,
          inject: [ProcessAttempt],
          useFactory: (processor: ProcessAttempt) => new Reconciler(processor),
        },
        {
          provide: MessageWorker,
          inject: [Database, PaymentInbox],
          useFactory: (db: Database, inbox: PaymentInbox) =>
            new MessageWorker(
              new Broker({
                url: config.AMQP_URL,
                namespace: config.MESSAGE_NAMESPACE,
                consumer: 'payments',
                routes: commerceRoutes,
              }),
              new Outbox((sql, ...values) => db.$queryRawUnsafe(sql, ...values)),
              (event) => inbox.handle(event),
            ),
        },
        {
          provide: 'PAYMENTS_READINESS',
          inject: [Database, Readiness],
          useFactory: (db: Database, readiness: Readiness) => {
            readiness.register('postgres', () =>
              db.paymentAttempt.count({ where: { id: '00000000-0000-0000-0000-000000000000' } }),
            );
            return readiness;
          },
        },
      ],
    };
  }
}
