import { Module, type DynamicModule } from '@nestjs/common';
import {
  ClientCredentials,
  HealthModule,
  Readiness,
  TokenVerifier,
} from '@eventflow/service-runtime';
import { Broker, MessageWorker } from '@eventflow/messaging';
import { commerceRoutes } from '@eventflow/event-contracts';
import type { AnalyticsConfig } from './config';
import { ClickHouse } from './clickhouse';
import { Journal } from './journal';
import { AnalyticsProjection, AnalyticsWorker } from './projection';
import { BookingAnalytics } from './booking';
import { AnalyticsReport } from './report';
import { AnalyticsIngest } from './ingest';
import { AnalyticsController, ANALYTICS_CONFIG } from './controller';
@Module({ imports: [HealthModule.forService('analytics')] })
export class AppModule {
  static configure(config: AnalyticsConfig): DynamicModule {
    const workers = config.EVENTFLOW_WORKLOAD !== 'http';
    return {
      module: AppModule,
      controllers: config.EVENTFLOW_WORKLOAD === 'worker' ? [] : [AnalyticsController],
      providers: [
        { provide: ANALYTICS_CONFIG, useValue: config },
        { provide: ClickHouse, useFactory: () => new ClickHouse(config) },
        { provide: Journal, useFactory: () => new Journal(config.ANALYTICS_DATABASE_URL) },
        {
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-analytics'),
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
        {
          provide: 'ANALYTICS_CREDENTIALS',
          useFactory: () =>
            new ClientCredentials(
              config.OIDC_ISSUER,
              'eventflow-analytics',
              config.ANALYTICS_CLIENT_SECRET,
            ),
        },
        {
          provide: AnalyticsProjection,
          inject: [Journal, ClickHouse],
          useFactory: (journal: Journal, engine: ClickHouse) =>
            new AnalyticsProjection(journal, engine),
        },
        {
          provide: BookingAnalytics,
          inject: [Journal],
          useFactory: (journal: Journal) => new BookingAnalytics(journal),
        },
        {
          provide: AnalyticsReport,
          inject: [ClickHouse, AnalyticsProjection],
          useFactory: (engine: ClickHouse, projection: AnalyticsProjection) =>
            new AnalyticsReport(engine, projection),
        },
        {
          provide: AnalyticsIngest,
          inject: [Journal, 'ANALYTICS_CREDENTIALS'],
          useFactory: (journal: Journal, credentials: ClientCredentials) =>
            new AnalyticsIngest(journal, config.CATALOG_URL, credentials),
        },
        ...(workers
          ? [
              {
                provide: AnalyticsWorker,
                inject: [AnalyticsProjection],
                useFactory: (p: AnalyticsProjection) => new AnalyticsWorker(p),
              },
              {
                provide: MessageWorker,
                inject: [BookingAnalytics],
                useFactory: (booking: BookingAnalytics) =>
                  new MessageWorker(
                    new Broker({
                      url: config.AMQP_URL,
                      namespace: config.MESSAGE_NAMESPACE,
                      consumer: 'analytics',
                      routes: commerceRoutes,
                    }),
                    undefined,
                    (event) => booking.handle(event),
                  ),
              },
            ]
          : []),
        {
          provide: 'ANALYTICS_READINESS',
          inject: [Readiness, Journal, AnalyticsProjection],
          useFactory: (ready: Readiness, journal: Journal, projection: AnalyticsProjection) => {
            ready.register('journal', async () => {
              await journal.pool.query('SELECT 1');
            });
            ready.register('clickhouse', () => projection.status());
            return ready;
          },
        },
      ],
    };
  }
}
