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
      ],
      providers: [
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
        ...[MembershipService, InvitationService, DraftService, PolicyService].map((service) => ({
          provide: service,
          useFactory: (db: Database) => new service(db),
          inject: [Database],
        })),
      ],
    };
  }
}
