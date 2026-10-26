import { Module, type DynamicModule } from '@nestjs/common';
import {
  ClientCredentials,
  HealthModule,
  Mailpit,
  MailQueue,
  MailWorker,
  Readiness,
  SecretBox,
  TokenVerifier,
} from '@eventflow/service-runtime';
import { Broker, MessageWorker, Outbox } from '@eventflow/messaging';
import {
  commerceRoutes,
  orderStatisticsSchema,
  availabilitySchema,
} from '@eventflow/event-contracts';
import { Database } from './database';
import { Booking } from './booking';
import { WaitlistQueue } from './queue';
import { Coordinator } from './coordinator';
import { TemporalRuntime } from './runtime';
import { OfferMail } from './mail';
import { WaitlistMetrics } from './metrics';
import { CONFIG, WaitlistController } from './controller';
import type { WaitlistConfig } from './config';
@Module({ imports: [HealthModule.forService('waitlist')] })
export class AppModule {
  static configure(config: WaitlistConfig): DynamicModule {
    const workers = config.EVENTFLOW_WORKLOAD !== 'http';
    return {
      module: AppModule,
      controllers: config.EVENTFLOW_WORKLOAD === 'worker' ? [] : [WaitlistController],
      providers: [
        { provide: CONFIG, useValue: config },
        {
          provide: WaitlistMetrics,
          inject: [Database, ...(workers ? [TemporalRuntime] : [])],
          useFactory: (db: Database, runtime?: TemporalRuntime) => new WaitlistMetrics(db, runtime),
        },
        { provide: Database, useFactory: () => new Database(config.WAITLIST_DATABASE_URL) },
        {
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-waitlist'),
        },
        {
          provide: ClientCredentials,
          useFactory: () =>
            new ClientCredentials(
              config.OIDC_ISSUER,
              'eventflow-policy',
              config.POLICY_CLIENT_SECRET,
            ),
        },
        { provide: SecretBox, useFactory: () => new SecretBox(config.WAITLIST_CONTACT_KEY) },
        {
          provide: Booking,
          useFactory: () =>
            new Booking(
              config.BOOKING_URL,
              new ClientCredentials(
                config.OIDC_ISSUER,
                'eventflow-waitlist',
                config.WAITLIST_CLIENT_SECRET,
              ),
            ),
        },
        {
          provide: WaitlistQueue,
          inject: [Database, Booking, SecretBox],
          useFactory: (db: Database, b: Booking, s: SecretBox) => new WaitlistQueue(db, b, s),
        },
        {
          provide: Coordinator,
          inject: [Database, Booking, SecretBox],
          useFactory: (db: Database, b: Booking, s: SecretBox) => new Coordinator(db, b, s),
        },
        ...(workers
          ? [
              {
                provide: TemporalRuntime,
                inject: [Database, Coordinator],
                useFactory: (db: Database, c: Coordinator) => new TemporalRuntime(config, db, c),
              },
              {
                provide: OfferMail,
                inject: [Database, Booking, SecretBox],
                useFactory: (db: Database, b: Booking, s: SecretBox) =>
                  new OfferMail(
                    db,
                    b,
                    s,
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
                    new Outbox(
                      async <T>(sql: string, ...v: unknown[]) => db.query(sql, ...v) as Promise<T>,
                    ),
                    async (event) => {
                      if (event.producer !== 'booking')
                        throw new Error('Invalid waitlist wake producer');
                      if (event.eventType === 'SaleAvailabilityChanged.v1')
                        availabilitySchema.parse(event.data);
                      const id =
                        event.eventType === 'OrderStatisticsChanged.v1'
                          ? orderStatisticsSchema.parse(event.data).saleId
                          : event.aggregateId;
                      await db.query(
                        'UPDATE workflow_dispatch SET revision=revision+1 WHERE sale_id=$1',
                        id,
                      );
                    },
                  ),
              },
            ]
          : []),
        {
          provide: 'WAITLIST_READINESS',
          inject: [Readiness, Database, ...(workers ? [TemporalRuntime] : [])],
          useFactory: (ready: Readiness, db: Database, runtime?: TemporalRuntime) => {
            ready.register('postgres', async () => {
              await db.query('SELECT 1');
            });
            if (runtime) ready.register('temporal', () => runtime.status());
            return ready;
          },
        },
      ],
    };
  }
}
