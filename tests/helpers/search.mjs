import { createApplication, ClientCredentials } from '../../packages/service-runtime/dist/index.js';
import { AppModule } from '../../services/search/dist/app.module.js';
import { readSearchConfig } from '../../services/search/dist/config.js';
import { OpenSearch } from '../../services/search/dist/opensearch.js';
import { IndexStore } from '../../services/search/dist/index-store.js';
import { ProjectionLease } from '../../services/search/dist/lease.js';
import { SearchProjection, ProjectionWorker } from '../../services/search/dist/projection.js';
import { MessageWorker } from '../../packages/messaging/dist/index.js';
import { decodeJwt } from 'jose';
import { catalogFixture } from '../../services/catalog/tests/fixture.mjs';
import { searchEngineFixture } from './opensearch.mjs';
import { cleanBroker } from './broker.mjs';
import { eventually } from './eventually.mjs';

export async function searchFixture({ rabbit = false } = {}) {
  const fixture = searchEngineFixture(),
    replicas = [];
  const catalog = await catalogFixture(
    rabbit ? { AMQP_URL: process.env.AMQP_URL, MESSAGE_NAMESPACE: fixture.namespace } : {},
  );
  const issuer = decodeJwt(await catalog.token()).iss;
  return {
    ...fixture,
    catalog,
    token: () =>
      catalog.token({
        aud: 'eventflow-search',
        azp: 'eventflow-search',
        realm_access: { roles: ['search-index'] },
      }),
    async start({ workers = false, prepare = true } = {}) {
      const config = readSearchConfig({
        ...process.env,
        ...fixture.engine.config,
        OIDC_ISSUER: issuer,
        CATALOG_URL: catalog.origin,
        MESSAGE_NAMESPACE: fixture.namespace,
        EVENTFLOW_WORKLOAD: workers ? 'combined' : 'http',
      });
      const module = AppModule.configure(config);
      module.providers = module.providers.map((provider) =>
        typeof provider === 'object' && provider.provide === ClientCredentials
          ? {
              provide: ClientCredentials,
              useValue: {
                token: () =>
                  catalog.token({
                    azp: 'eventflow-search',
                    realm_access: { roles: ['search-index'] },
                  }),
              },
            }
          : provider,
      );
      const app = await createApplication(module, { name: 'search' });
      replicas.push(app);
      app.useLogger(false);
      await app.listen(0, '127.0.0.1');
      const result = {
        app,
        origin: await app.getUrl(),
        config,
        engine: app.get(OpenSearch),
        store: app.get(IndexStore),
        lease: app.get(ProjectionLease),
        projection: app.get(SearchProjection),
        ...(workers
          ? { worker: app.get(ProjectionWorker), broker: app.get(MessageWorker).broker }
          : {}),
      };
      if (prepare && !workers) await result.projection.sync();
      if (prepare && workers)
        await eventually(
          async () => {
            try {
              // A globally ready index does not imply this replica has initialized its worker.
              await result.projection.sync();
              await result.store.ready();
              return result.broker.ready;
            } catch {
              return false;
            }
          },
          Boolean,
          30000,
        );
      return result;
    },
    async close() {
      for (const app of replicas) await app.close();
      await catalog.close();
      await fixture.close();
      if (rabbit) await cleanBroker(fixture.namespace);
    },
  };
}
