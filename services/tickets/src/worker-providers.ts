import type { FactoryProvider, Provider } from '@nestjs/common';
import { commerceRoutes } from '@eventflow/event-contracts';
import { Broker, MessageWorker, Outbox } from '@eventflow/messaging';
import { MailQueue, MailWorker, Readiness } from '@eventflow/service-runtime';
import type { TicketsConfig } from './config';
import { Database } from './database';
import { IssueTickets } from './issue';
import { DeliverTickets } from './deliver';
import { TicketRefunds } from './refunds';

export function ticketsWorkerProviders(config: TicketsConfig): Provider[] {
  return [
    {
      provide: 'TICKETS_REFUNDS_WORKER',
      inject: [Database],
      useFactory: (db: Database) =>
        new MessageWorker(
          new Broker({
            url: config.AMQP_URL,
            namespace: config.MESSAGE_NAMESPACE,
            consumer: 'ticket-refunds',
            routes: commerceRoutes,
          }),
          undefined,
          (event) => new TicketRefunds(db).handle(event),
        ),
    },
    {
      provide: MailWorker,
      inject: [MailQueue, Database],
      useFactory: (queue: MailQueue, db: Database) => {
        const delivery = new DeliverTickets(config);
        return new MailWorker(
          queue,
          async (id) => {
            const gate = await db.refundGate.findUnique({ where: { operationId: id } });
            return gate?.state === 'REVOKED'
              ? delivery.refund(id, gate.orderId)
              : delivery.send(id);
          },
          config.MAIL_DELIVERY_DISABLED !== 'true',
        );
      },
    },
    {
      provide: MessageWorker,
      inject: [IssueTickets, Database],
      useFactory: (issue: IssueTickets, db: Database) =>
        new MessageWorker(
          new Broker({
            url: config.AMQP_URL,
            namespace: config.MESSAGE_NAMESPACE,
            consumer: 'tickets',
            routes: commerceRoutes,
          }),
          new Outbox((sql, ...values) => db.$queryRawUnsafe(sql, ...values)),
          (event) => issue.handle(event),
        ),
    },
  ];
}

export const ticketsBrokerReadiness: FactoryProvider = {
  provide: 'BROKER_READINESS',
  inject: [Readiness, MessageWorker, 'TICKETS_REFUNDS_WORKER'],
  useFactory: (readiness: Readiness, worker: MessageWorker, refunds: MessageWorker) => {
    readiness.register('rabbitmq', async () => {
      if (!worker.broker.ready || !refunds.broker.ready)
        throw new Error('RabbitMQ consumer unavailable');
    });
    return readiness;
  },
};
