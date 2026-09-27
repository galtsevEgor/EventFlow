import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, Readiness, probeIdentity } from '@eventflow/service-runtime';
import { AuthModule } from './auth/auth.module';
import type { AuthConfig } from './auth/config';
import { CatalogController } from './catalog.controller';
import { SessionStore } from './auth/session-store';
import { CoverProxyController, CoverSessionGuard } from './covers.controller';
import { PublicController } from './public.controller';
import { OrdersController } from './orders.controller';
import { PaymentWebhooksController } from './payment-webhooks.controller';
import { CheckInProxy } from './check-in.controller';
import { AUTH_CONFIG } from './auth/config';
import { RealtimeBus } from './realtime/bus';
import { RealtimeHub } from './realtime/hub';
import { StreamQuota } from './realtime/quota';
import { UpdatesAccess } from './realtime/access';
import { UpdatesController } from './realtime/controller';
import { AuthService } from './auth/auth.service';

@Module({ imports: [HealthModule.forService('bff')] })
export class AppModule {
  static configure(config: AuthConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [AuthModule.configure(config)],
      controllers: [
        UpdatesController,
        CoverProxyController,
        PublicController,
        CatalogController,
        OrdersController,
        PaymentWebhooksController,
        CheckInProxy,
      ],
      providers: [
        {
          provide: RealtimeBus,
          inject: [AUTH_CONFIG, SessionStore],
          useFactory: (config: AuthConfig, store: SessionStore) => new RealtimeBus(config, store),
        },
        {
          provide: UpdatesAccess,
          inject: [AuthService],
          useFactory: (auth: AuthService) => new UpdatesAccess(auth),
        },
        {
          provide: StreamQuota,
          inject: [SessionStore, AUTH_CONFIG],
          useFactory: (store: SessionStore, config: AuthConfig) => new StreamQuota(store, config),
        },
        {
          provide: RealtimeHub,
          inject: [AUTH_CONFIG, RealtimeBus, UpdatesAccess, StreamQuota],
          useFactory: (
            config: AuthConfig,
            bus: RealtimeBus,
            access: UpdatesAccess,
            quota: StreamQuota,
          ) => new RealtimeHub(config, bus, access, quota),
        },
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
