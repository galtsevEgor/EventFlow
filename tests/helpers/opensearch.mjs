import { randomUUID } from 'node:crypto';
import { OpenSearch } from '../../services/search/dist/opensearch.js';
export function searchEngineFixture() {
  const namespace = 'eventflow-test-' + randomUUID();
  const engine = new OpenSearch({
    OPENSEARCH_URL: process.env.OPENSEARCH_URL ?? 'http://127.0.0.1:19200',
    SEARCH_INDEX_NAMESPACE: namespace,
  });
  return {
    engine,
    namespace,
    async close() {
      // Only this fixture's UUID namespace can be deleted.
      if (!/^eventflow-test-[a-f0-9-]{36}$/.test(namespace))
        throw new Error('Unsafe test namespace');
      await engine.request('/' + namespace + '-*', 'DELETE').catch((error) => {
        if (error.status !== 404) throw error;
      });
    },
  };
}
