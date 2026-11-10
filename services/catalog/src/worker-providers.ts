import type { FactoryProvider, Provider } from '@nestjs/common';
import { commerceRoutes } from '@eventflow/event-contracts';
import { Broker, MessageWorker, Outbox } from '@eventflow/messaging';
import { MailQueue, MailWorker, Readiness, SecretBox } from '@eventflow/service-runtime';
import type { CatalogConfig } from './config';
import { Database } from './database';
import { DeliverInvitation } from './organizations/deliver-invitation';
import { PublicationConsumer } from './publication/consumer';
import { StatisticsConsumer } from './statistics/consumer';

export function catalogMailWorker(config: CatalogConfig): FactoryProvider {
  return {
    provide: MailWorker,
    inject: [Database, MailQueue, SecretBox],
    useFactory: (db: Database, queue: MailQueue, box: SecretBox) => {
      const delivery = new DeliverInvitation(db, config, box);
      return new MailWorker(
        queue,
        (id) => delivery.send(id),
        config.MAIL_DELIVERY_DISABLED !== 'true',
      );
    },
  };
}

export function catalogWorkerProviders(config: CatalogConfig): Provider[] {
  return [
    {
      provide: MessageWorker,
      inject: [Database, PublicationConsumer],
      useFactory: (db: Database, consumer: PublicationConsumer) =>
        new MessageWorker(
          new Broker({
            url: config.AMQP_URL,
            namespace: config.MESSAGE_NAMESPACE,
            consumer: 'catalog',
            routes: commerceRoutes,
          }),
          new Outbox((sql, ...values) => db.$queryRawUnsafe(sql, ...values)),
          (event) => consumer.handle(event),
        ),
    },
    {
      provide: 'STATISTICS_WORKER',
      inject: [Database],
      useFactory: (db: Database) =>
        new MessageWorker(
          new Broker({
            url: config.AMQP_URL,
            namespace: config.MESSAGE_NAMESPACE,
            consumer: 'statistics',
            routes: commerceRoutes,
          }),
          undefined,
          (event) => new StatisticsConsumer(db).handle(event),
        ),
    },
    {
      provide: 'CATALOG_REFUNDS_WORKER',
      inject: [Database],
      useFactory: (db: Database) =>
        new MessageWorker(
          new Broker({
            url: config.AMQP_URL,
            namespace: config.MESSAGE_NAMESPACE,
            consumer: 'catalog-refunds',
            routes: commerceRoutes,
          }),
          undefined,
          (event) => new StatisticsConsumer(db).handle(event),
        ),
    },
  ];
}

export const catalogBrokerReadiness: FactoryProvider = {
  provide: 'BROKER_READINESS',
  inject: [Readiness, MessageWorker, 'STATISTICS_WORKER', 'CATALOG_REFUNDS_WORKER'],
  useFactory: (
    readiness: Readiness,
    worker: MessageWorker,
    statistics: MessageWorker,
    refunds: MessageWorker,
  ) => {
    readiness.register('rabbitmq', async () => {
      if (!worker.broker.ready) throw new Error('RabbitMQ consumer unavailable');
      if (!statistics.broker.ready || !refunds.broker.ready)
        throw new Error('Statistics consumer unavailable');
    });
    return readiness;
  },
};
