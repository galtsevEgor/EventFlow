import assert from 'node:assert/strict';
import test from 'node:test';
import { searchEngineFixture } from '../helpers/opensearch.mjs';
import { readSearchConfig } from '../../services/search/dist/config.js';
import { AppModule } from '../../services/search/dist/app.module.js';
import { createApplication } from '../../packages/service-runtime/dist/index.js';

test('real OpenSearch initializes one strict index and alias under concurrent startup', async () => {
  const f = searchEngineFixture();
  try {
    const indexes = await Promise.all([f.engine.ensure(), f.engine.ensure()]);
    assert.equal(indexes[0], indexes[1]);
    const mapping = await f.engine.request('/' + indexes[0] + '/_mapping');
    assert.equal(mapping[indexes[0]].mappings.dynamic, 'strict');
    assert.equal(mapping[indexes[0]].mappings._meta.eventflowSearchSchema, 1);
    await assert.rejects(
      f.engine.request('/' + indexes[0] + '/_doc/private', 'PUT', { accessToken: 'not-indexable' }),
      (error) => error.status === 400,
    );
    assert.equal((await f.engine.request('/' + indexes[0] + '/_count')).count, 0);
  } finally {
    await f.close();
  }
});
test('Search exposes dependency readiness and rejects external or ambiguous engine URLs', async () => {
  const f = searchEngineFixture();
  const config = readSearchConfig(f.engine.config);
  const app = await createApplication(AppModule.configure(config), { name: 'search' });
  try {
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const response = await fetch((await app.getUrl()) + '/health/ready');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'search' });
    for (const OPENSEARCH_URL of [
      'https://external.test',
      'http://127.0.0.1:19200/private',
      'http://user:secret@127.0.0.1:19200',
      'http://127.0.0.1:19200/?token=secret',
    ])
      assert.throws(() => readSearchConfig({ OPENSEARCH_URL }));
  } finally {
    await app.close();
    await f.close();
  }
});
