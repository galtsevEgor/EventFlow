import type { Provider } from '@nestjs/common';
import { Mailpit, MailQueue, MailWorker, SecretBox } from '@eventflow/service-runtime';
import { Broker, MessageWorker, Outbox } from '@eventflow/messaging';
import {
  availabilitySchema,
  commerceRoutes,
  orderStatisticsSchema,
  type EventEnvelope,
} from '@eventflow/event-contracts';
import { Booking } from './booking';
import type { WaitlistConfig } from './config';
import { Coordinator } from './coordinator';
import { Database } from './database';
import { OfferMail } from './mail';
import { TemporalRuntime } from './runtime';

async function wakeForBookingEvent(db: Database, event: EventEnvelope) {
  if (event.producer !== 'booking') throw new Error('Invalid waitlist wake producer');
  if (event.eventType === 'SaleAvailabilityChanged.v1') availabilitySchema.parse(event.data);
  const saleId =
    event.eventType === 'OrderStatisticsChanged.v1'
      ? orderStatisticsSchema.parse(event.data).saleId
      : event.aggregateId;
  await db.query('UPDATE workflow_dispatch SET revision=revision+1 WHERE sale_id=$1', saleId);
}

export function waitlistWorkerProviders(config: WaitlistConfig): Provider[] {
  return [
    {
      provide: TemporalRuntime,
      inject: [Database, Coordinator],
      useFactory: (db: Database, coordinator: Coordinator) =>
        new TemporalRuntime(config, db, coordinator),
    },
    {
      provide: OfferMail,
      inject: [Database, Booking, SecretBox],
      useFactory: (db: Database, booking: Booking, box: SecretBox) =>
        new OfferMail(
          db,
          booking,
          box,
          new Mailpit(config.MAILPIT_SMTP_PORT, 'waitlist', config.MAILPIT_SMTP_HOST),
          config.PUBLIC_ORIGIN,
        ),
    },
    {
      provide: MailWorker,
      inject: [Database, OfferMail],
      useFactory: (db: Database, mail: OfferMail) =>
        new MailWorker(
          new MailQueue(
            async <T>(sql: string, ...v: unknown[]) => db.query(sql, ...v) as Promise<T>,
          ),
          (id) => mail.send(id),
          config.MAIL_DELIVERY_DISABLED !== 'true',
        ),
    },
    {
      provide: MessageWorker,
      inject: [Database],
      useFactory: (db: Database) =>
        new MessageWorker(
          new Broker({
            url: config.AMQP_URL,
            namespace: config.MESSAGE_NAMESPACE,
            consumer: 'waitlist',
            routes: commerceRoutes,
          }),
          new Outbox(async <T>(sql: string, ...v: unknown[]) => db.query(sql, ...v) as Promise<T>),
          (event) => wakeForBookingEvent(db, event),
        ),
    },
  ];
}
