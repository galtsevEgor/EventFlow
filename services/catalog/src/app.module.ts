import { Module, type DynamicModule } from '@nestjs/common';
import {
  HealthModule,
  MailOperator,
  MailQueue,
  MailWorker,
  Readiness,
  SecretBox,
  probeIdentity,
  TokenVerifier,
} from '@eventflow/service-runtime';
import { Database } from './database';
import type { CatalogConfig } from './config';
import { OrganizationController } from './organizations/organization.controller';
import { OrganizationService } from './organizations/organization.service';
import { UserGuard } from './user.guard';
import { MembershipController } from './organizations/membership.controller';
import { MembershipService } from './organizations/membership.service';
import { InvitationService } from './organizations/invitation.service';
import { DeliverInvitation } from './organizations/deliver-invitation';
import { DraftController } from './events/draft.controller';
import { DraftService } from './events/draft.service';
import { PolicyController } from './policy/policy.controller';
import { PolicyService } from './policy/policy.service';
import { CoverController, PublicCoverController } from './covers/cover.controller';
import { CoverService } from './covers/cover.service';
import { CoverStorage } from './covers/storage';
import { Broker, Outbox, MessageWorker } from '@eventflow/messaging';
import { commerceRoutes } from '@eventflow/event-contracts';
import { PublicationService } from './publication/publication.service';
import { PublicationController } from './publication/publication.controller';
import { PublicationConsumer } from './publication/consumer';
import { AvailabilityService } from './publication/availability.service';
import { PublicCatalog } from './public-catalog/catalog.service';
import { PublicCatalogController } from './public-catalog/catalog.controller';
import { StatisticsConsumer } from './statistics/consumer';
import { StatisticsReport } from './statistics/report';
import { StatisticsController } from './statistics/controller';
import { CatalogOps } from './ops.controller';
import { DraftDocumentController } from './collaboration/controller';
import { DraftDocumentService } from './collaboration/document.service';
import { SearchFeed } from './search/feed.service';
import { SearchFeedController } from './search/feed.controller';

@Module({ imports: [HealthModule.forService('catalog')] })
export class AppModule {
  static configure(config: CatalogConfig): DynamicModule {
    const runWorkers = config.EVENTFLOW_WORKLOAD !== 'http';
    return {
      module: AppModule,
      controllers:
        config.EVENTFLOW_WORKLOAD === 'worker'
          ? []
          : [
              OrganizationController,
              MembershipController,
              DraftController,
              DraftDocumentController,
              SearchFeedController,
              PolicyController,
              CoverController,
              PublicCoverController,
              PublicationController,
              PublicCatalogController,
              StatisticsController,
              MailOperator,
              CatalogOps,
            ],
      providers: [
        {
          provide: SearchFeed,
          inject: [Database],
          useFactory: (db: Database) => new SearchFeed(db),
        },
        {
          provide: DraftDocumentService,
          inject: [Database],
          useFactory: (db: Database) => new DraftDocumentService(db),
        },
        {
          provide: StatisticsReport,
          inject: [Database],
          useFactory: (db: Database) => new StatisticsReport(db),
        },
        ...(runWorkers
          ? [
              {
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
              },
            ]
          : []),
        {
          provide: PublicCatalog,
          inject: [Database],
          useFactory: (db: Database) => new PublicCatalog(db),
        },
        {
          provide: AvailabilityService,
          inject: [Database],
          useFactory: (db: Database) => new AvailabilityService(db),
        },
        {
          provide: PublicationService,
          inject: [Database],
          useFactory: (db: Database) => new PublicationService(db),
        },
        {
          provide: PublicationConsumer,
          inject: [Database],
          useFactory: (db: Database) => new PublicationConsumer(db),
        },
        ...(runWorkers && config.AMQP_URL
          ? [
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
                      url: config.AMQP_URL!,
                      namespace: config.MESSAGE_NAMESPACE,
                      consumer: 'catalog-refunds',
                      routes: commerceRoutes,
                    }),
                    undefined,
                    (event) => new StatisticsConsumer(db).handle(event),
                  ),
              },
            ]
          : []),
        {
          provide: CoverStorage,
          useFactory: () => (config.S3_ENDPOINT ? new CoverStorage(config) : null),
        },
        {
          provide: CoverService,
          useFactory: (db: Database, storage: CoverStorage | null, drafts: DraftService) =>
            new CoverService(db, storage, drafts),
          inject: [Database, CoverStorage, DraftService],
        },
        {
          provide: Database,
          useFactory: () => new Database(config.CATALOG_DATABASE_URL, config.DATABASE_POOL_SIZE),
        },
        {
          provide: 'CATALOG_READINESS',
          inject: [Readiness, Database],
          useFactory: (readiness: Readiness, db: Database) => {
            readiness.register('postgres', () =>
              db.eventDraft.count({ where: { id: '00000000-0000-0000-0000-000000000000' } }),
            );
            readiness.register('identity', () => probeIdentity(config.OIDC_ISSUER));
            return readiness;
          },
        },
        {
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-catalog'),
        },
        {
          provide: OrganizationService,
          useFactory: (db: Database) => new OrganizationService(db),
          inject: [Database],
        },
        UserGuard,
        {
          provide: DraftService,
          useFactory: (db: Database) => new DraftService(db, config.MAXIMUM_PRICE_MINOR),
          inject: [Database],
        },
        { provide: SecretBox, useFactory: () => new SecretBox(config.CATALOG_INVITATION_KEY) },
        {
          provide: InvitationService,
          inject: [Database, SecretBox],
          useFactory: (db: Database, box: SecretBox) => new InvitationService(db, box),
        },
        {
          provide: MailQueue,
          inject: [Database],
          useFactory: (db: Database) =>
            new MailQueue(
              (sql, ...values) => db.$queryRawUnsafe(sql, ...values),
              (operation) =>
                db.$transaction((tx) =>
                  operation((sql, ...values) => tx.$queryRawUnsafe(sql, ...values)),
                ),
            ),
        },
        ...[MembershipService, PolicyService].map((service) => ({
          provide: service,
          useFactory: (db: Database) => new service(db),
          inject: [Database],
        })),
        ...(config.EVENTFLOW_WORKLOAD === 'worker'
          ? [
              {
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
              },
            ]
          : []),
      ],
    };
  }
}
