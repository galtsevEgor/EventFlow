import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, TokenVerifier } from '@eventflow/service-runtime';
import { Database } from './database';
import type { CatalogConfig } from './config';
import { OrganizationController } from './organizations/organization.controller';
import { OrganizationService } from './organizations/organization.service';
import { UserGuard } from './user.guard';

@Module({ imports: [HealthModule.forService('catalog')] })
export class AppModule {
  static configure(config: CatalogConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [OrganizationController],
      providers: [
        { provide: Database, useFactory: () => new Database(config.CATALOG_DATABASE_URL) },
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
      ],
    };
  }
}
