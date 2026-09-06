import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, Readiness, probeIdentity } from '@eventflow/service-runtime';
import { AuthModule } from './auth/auth.module';
import type { AuthConfig } from './auth/config';
import { CatalogController } from './catalog.controller';
import { SessionStore } from './auth/session-store';
import { CoverProxyController, CoverSessionGuard } from './covers.controller';
import { PublicController } from './public.controller';
import { OrdersController } from './orders.controller';

@Module({ imports: [HealthModule.forService('bff')] })
export class AppModule {
  static configure(config: AuthConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [AuthModule.configure(config)],
      controllers: [CoverProxyController, PublicController, CatalogController, OrdersController],
      providers: [
        CoverSessionGuard,
        {
          provide: 'BFF_READINESS',
          inject: [Readiness, SessionStore],
          useFactory: (readiness: Readiness, store: SessionStore) => {
            readiness.register('redis', () => store.execute(() => store.client.ping()));
            readiness.register('identity', () => probeIdentity(config.OIDC_ISSUER));
            return readiness;
          },
        },
      ],
    };
  }
}
