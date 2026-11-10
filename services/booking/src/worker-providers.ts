import type { FactoryProvider, Provider } from '@nestjs/common';
import { Readiness } from '@eventflow/service-runtime';
import { Broker, Outbox, MessageWorker } from '@eventflow/messaging';
import { commerceRoutes } from '@eventflow/event-contracts';
import { Database } from './database';
import { ProvisionSale } from './provision';
import { ChangeAvailability } from './availability';
import type { BookingConfig } from './config';
import { OrderLifecycle } from './orders/lifecycle';
import { OrderSweeper } from './orders/sweeper';
import { ConfirmPayment } from './payments/confirm';
import { RefundOutcome } from './payments/refund-outcome';
import { RefundWorkflow } from './refunds/workflow';

export function bookingWorkerProviders(config: BookingConfig): Provider[] {
  return [
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
      useFactory: (db: Database, lifecycle: OrderLifecycle) => new OrderSweeper(db, lifecycle),
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
          (event) => {
            if (event.eventType.startsWith('Refund')) return new RefundOutcome(db).handle(event);
            if (event.eventType === 'PaymentSucceeded.v1')
              return new ConfirmPayment(db).handle(event);
            if (event.eventType === 'SaleAvailabilityRequested.v1')
              return new ChangeAvailability(db).handle(event);
            return provision.handle(event);
          },
        ),
    },
  ];
}

export const bookingBrokerReadiness: FactoryProvider = {
  provide: 'BROKER_READINESS',
  inject: [Readiness, MessageWorker, 'BOOKING_REFUNDS_WORKER'],
  useFactory: (readiness: Readiness, worker: MessageWorker, refunds: MessageWorker) => {
    readiness.register('rabbitmq', async () => {
      if (!worker.broker.ready || !refunds.broker.ready)
        throw new Error('RabbitMQ consumer unavailable');
    });
    return readiness;
  },
};
