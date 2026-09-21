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
import { ProcessRefund } from './refunds/process';
import { StripePaymentProvider } from './providers/stripe';
import { ReceiveWebhook } from './webhooks/receive';
import { ProcessWebhooks } from './webhooks/process';
import { WebhookController } from './webhooks/controller';
import { PaymentOperator } from './operator';

@Module({ imports: [HealthModule.forService('payments')] })
export class AppModule {
  static configure(config: PaymentsConfig): DynamicModule {
    const runWorkers = config.EVENTFLOW_WORKLOAD !== 'http';
    return {
      module: AppModule,
      controllers:
        config.EVENTFLOW_WORKLOAD === 'worker'
          ? []
          : [PaymentController, WebhookController, PaymentOperator],
      providers: [
        ...(runWorkers
          ? [
              {
                provide: 'PAYMENT_REFUNDS_WORKER',
                inject: [PaymentInbox],
                useFactory: (inbox: PaymentInbox) =>
                  new MessageWorker(
                    new Broker({
                      url: config.AMQP_URL,
                      namespace: config.MESSAGE_NAMESPACE,
                      consumer: 'payment-refunds',
                      routes: commerceRoutes,
                    }),
                    undefined,
                    (event) => inbox.handle(event),
                  ),
              },
              {
                provide: Reconciler,
                inject: [ProcessAttempt, ProcessRefund, ProcessWebhooks],
                useFactory: (
                  processor: ProcessAttempt,
                  refunds: ProcessRefund,
                  webhooks: ProcessWebhooks,
                ) => new Reconciler(processor, refunds, webhooks),
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
            ]
          : []),
        {
          provide: ReceiveWebhook,
          inject: [Database, 'PAYMENT_PROVIDER'],
          useFactory: (db: Database, provider: PaymentProvider) => new ReceiveWebhook(db, provider),
        },
        {
          provide: ProcessWebhooks,
          inject: [Database, 'PAYMENT_PROVIDER'],
          useFactory: (db: Database, provider: PaymentProvider) =>
            new ProcessWebhooks(db, provider),
        },
        {
          provide: ProcessRefund,
          inject: [Database, 'PAYMENT_PROVIDER'],
          useFactory: (db: Database, provider: PaymentProvider) => new ProcessRefund(db, provider),
        },
        {
          provide: Database,
          useFactory: () => new Database(config.PAYMENTS_DATABASE_URL, config.DATABASE_POOL_SIZE),
        },
        {
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-payments'),
        },
        { provide: BookingClient, useFactory: () => new BookingClient(config) },
        {
          provide: 'PAYMENT_PROVIDER',
          inject: [Database],
          useFactory: (db: Database) =>
            config.PAYMENT_PROVIDER === 'stripe'
              ? new StripePaymentProvider(config.STRIPE_SECRET_KEY!, config.STRIPE_WEBHOOK_SECRET!)
              : new FakePaymentProvider(db),
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
          ) => new ReadPayment(db, booking, provider, processor, config.STRIPE_PUBLISHABLE_KEY),
        },
        {
          provide: PaymentInbox,
          inject: [Database],
          useFactory: (db: Database) => new PaymentInbox(db),
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
        ...(config.EVENTFLOW_WORKLOAD === 'worker'
          ? [
              {
                provide: 'BROKER_READINESS',
                inject: [Readiness, MessageWorker, 'PAYMENT_REFUNDS_WORKER'],
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
