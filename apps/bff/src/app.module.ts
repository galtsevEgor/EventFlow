import { Module, type DynamicModule } from '@nestjs/common';
import { HealthModule, Readiness, probeIdentity, TokenVerifier } from '@eventflow/service-runtime';
import { AnalyticsProxy } from './analytics/controller';
import { WaitlistProxy } from './waitlist.controller';
import { OfflineCheckInProxy } from './offline-check-in.controller';
import { RecommendationsProxy } from './recommendations.controller';
import { AnalyticsBridge } from './analytics/service';
import { OpsController } from './ops.controller';
import { AuthModule } from './auth/auth.module';
import type { AuthConfig } from './auth/config';
import { CatalogController } from './catalog.controller';
import { SessionStore } from './auth/session-store';
import { CoverProxyController, CoverSessionGuard } from './covers.controller';
import { PublicController } from './public.controller';
import { SearchProxy } from './search.controller';
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
import { HttpAdapterHost } from '@nestjs/core';
import { CollaborationBus } from './collaboration/bus';
import { CollaborationHub } from './collaboration/hub';
import { DocumentPresence } from './collaboration/presence';
import { SwaggerController } from './swagger.controller';

@Module({ imports: [HealthModule.forService('bff')] })
export class AppModule {
  static configure(config: AuthConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [AuthModule.configure(config)],
      controllers: [
        SwaggerController,
        AnalyticsProxy,
        WaitlistProxy,
        OfflineCheckInProxy,
        RecommendationsProxy,
        UpdatesController,
        CoverProxyController,
        PublicController,
        SearchProxy,
        CatalogController,
        OrdersController,
        PaymentWebhooksController,
        CheckInProxy,
        OpsController,
      ],
      providers: [
        {
          provide: AnalyticsBridge,
          inject: [AuthService],
          useFactory: (auth: AuthService) => new AnalyticsBridge(auth.config),
        },
        {
          provide: DocumentPresence,
          inject: [SessionStore, AUTH_CONFIG],
          useFactory: (store: SessionStore, config: AuthConfig) =>
            new DocumentPresence(store, config.SESSION_PREFIX),
        },
        {
          provide: CollaborationBus,
          inject: [SessionStore, AUTH_CONFIG],
          useFactory: (store: SessionStore, config: AuthConfig) =>
            new CollaborationBus(store, config.SESSION_PREFIX),
        },
        {
          provide: CollaborationHub,
          inject: [HttpAdapterHost, AuthService, CollaborationBus, DocumentPresence],
          useFactory: (
            adapter: HttpAdapterHost,
            auth: AuthService,
            bus: CollaborationBus,
            presence: DocumentPresence,
          ) => new CollaborationHub(adapter, auth, bus, presence),
        },
        {
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-payments'),
        },
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
