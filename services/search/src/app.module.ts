import { Module, type DynamicModule } from '@nestjs/common';
import {
  ClientCredentials,
  HealthModule,
  Readiness,
  TokenVerifier,
} from '@eventflow/service-runtime';
import { Broker, MessageWorker } from '@eventflow/messaging';
import { commerceRoutes } from '@eventflow/event-contracts';
import type { SearchConfig } from './config';
import { OpenSearch } from './opensearch';
import { ProjectionLease } from './lease';
import { CatalogFeed } from './catalog-feed';
import { IndexStore } from './index-store';
import { SearchProjection, ProjectionWorker } from './projection';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({ imports: [HealthModule.forService('search')] })
export class AppModule {
  static configure(config: SearchConfig): DynamicModule {
    const workers = config.EVENTFLOW_WORKLOAD !== 'http';
    return {
      module: AppModule,
      controllers: config.EVENTFLOW_WORKLOAD === 'worker' ? [] : [SearchController],
      providers: [
        {
          provide: SearchService,
          inject: [OpenSearch, IndexStore],
          useFactory: (engine: OpenSearch, store: IndexStore) => new SearchService(engine, store),
        },
        { provide: OpenSearch, useFactory: () => new OpenSearch(config) },
        {
          provide: IndexStore,
          inject: [OpenSearch],
          useFactory: (engine: OpenSearch) => new IndexStore(engine),
        },
        {
          provide: ProjectionLease,
          useFactory: async () => {
            const lease = new ProjectionLease(config.REDIS_URL, config.SEARCH_INDEX_NAMESPACE);
            await lease.connect();
            return lease;
          },
        },
        {
          provide: ClientCredentials,
          useFactory: () =>
            new ClientCredentials(
              config.OIDC_ISSUER,
              'eventflow-search',
              config.SEARCH_CLIENT_SECRET,
            ),
        },
        {
          provide: TokenVerifier,
          useFactory: () => new TokenVerifier(config.OIDC_ISSUER, 'eventflow-search'),
        },
        {
          provide: CatalogFeed,
          inject: [ClientCredentials],
          useFactory: (credentials: ClientCredentials) =>
            new CatalogFeed(config.CATALOG_URL, credentials),
        },
        {
          provide: SearchProjection,
          inject: [OpenSearch, IndexStore, ProjectionLease, CatalogFeed],
          useFactory: (
            engine: OpenSearch,
            store: IndexStore,
            lease: ProjectionLease,
            feed: CatalogFeed,
          ) => new SearchProjection(engine, store, lease, feed),
        },
        ...(workers
          ? [
              {
                provide: ProjectionWorker,
                inject: [SearchProjection],
                useFactory: (projection: SearchProjection) => new ProjectionWorker(projection),
              },
              {
                provide: MessageWorker,
                inject: [SearchProjection],
                useFactory: (projection: SearchProjection) =>
                  new MessageWorker(
                    new Broker({
                      url: config.AMQP_URL,
                      namespace: config.MESSAGE_NAMESPACE,
                      consumer: 'search',
                      routes: commerceRoutes,
                    }),
                    undefined,
                    (event) => projection.project(event),
                  ),
              },
            ]
          : []),
        {
          provide: 'SEARCH_READINESS',
          inject: [IndexStore, Readiness],
          useFactory: (store: IndexStore, readiness: Readiness) => {
            readiness.register('search-index', () => store.ready());
            return readiness;
          },
        },
      ],
    };
  }
}
