import type { FactoryProvider, Provider } from '@nestjs/common';
import { Readiness } from '@eventflow/service-runtime';
import { Broker, MessageWorker, Outbox } from '@eventflow/messaging';
import { commerceRoutes } from '@eventflow/event-contracts';
import { Database } from './database';
import type { PaymentsConfig } from './config';
import { ProcessAttempt } from './attempts/process';
import { PaymentInbox } from './inbox';
import { Reconciler } from './reconciler';
import { ProcessRefund } from './refunds/process';
import { ProcessWebhooks } from './webhooks/process';

export function paymentsWorkerProviders(config: PaymentsConfig): Provider[] {
  return [
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
      useFactory: (processor: ProcessAttempt, refunds: ProcessRefund, webhooks: ProcessWebhooks) =>
        new Reconciler(processor, refunds, webhooks),
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
  ];
}

export const paymentsBrokerReadiness: FactoryProvider = {
  provide: 'BROKER_READINESS',
  inject: [Readiness, MessageWorker, 'PAYMENT_REFUNDS_WORKER'],
  useFactory: (readiness: Readiness, worker: MessageWorker, refunds: MessageWorker) => {
    readiness.register('rabbitmq', async () => {
      if (!worker.broker.ready || !refunds.broker.ready)
        throw new Error('RabbitMQ consumer unavailable');
    });
    return readiness;
  },
};
