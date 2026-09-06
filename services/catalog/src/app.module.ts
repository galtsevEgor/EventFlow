import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, Readiness, probeIdentity, TokenVerifier } from '@eventflow/service-runtime';
import { Database } from './database';
import type { CatalogConfig } from './config';
import { OrganizationController } from './organizations/organization.controller';
import { OrganizationService } from './organizations/organization.service';
import { UserGuard } from './user.guard';
import { MembershipController } from './organizations/membership.controller';
import { MembershipService } from './organizations/membership.service';
import { InvitationService } from './organizations/invitation.service';
import { DraftController } from './events/draft.controller';
import { DraftService } from './events/draft.service';
import { PolicyController } from './policy/policy.controller';
import { PolicyService } from './policy/policy.service';
import { CoverController, PublicCoverController } from './covers/cover.controller';
import { CoverService } from './covers/cover.service';
import { CoverStorage } from './covers/storage';
import { Broker, Outbox, MessageWorker } from '@eventflow/messaging';
import { saleRoutes } from '@eventflow/event-contracts';
import { PublicationService } from './publication/publication.service';
import { PublicationController } from './publication/publication.controller';
import { PublicationConsumer } from './publication/consumer';
import { AvailabilityService } from './publication/availability.service';

@Module({ imports: [HealthModule.forService('catalog')] })
export class AppModule {
  static configure(config: CatalogConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        OrganizationController,
        MembershipController,
        DraftController,
        PolicyController,
        CoverController,
        PublicCoverController,
        PublicationController,
      ],
      providers: [
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
        ...(config.AMQP_URL
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
                      routes: saleRoutes,
                    }),
                    new Outbox((sql, ...values) => db.$queryRawUnsafe(sql, ...values)),
                    (event) => consumer.handle(event),
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
        { provide: Database, useFactory: () => new Database(config.CATALOG_DATABASE_URL) },
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
        ...[MembershipService, InvitationService, PolicyService].map((service) => ({
          provide: service,
          useFactory: (db: Database) => new service(db),
          inject: [Database],
        })),
      ],
    };
  }
}
