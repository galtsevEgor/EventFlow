import assert from 'node:assert/strict';
import test from 'node:test';
import { Module } from '@nestjs/common';
import {
  createApplication,
  HealthModule,
  localServiceOrigin,
  localServicePorts,
  messageNamespaceSchema,
  readServiceConfig,
} from '../dist/index.js';

test('validates ports and rejects malformed environment configuration', () => {
  const defaults = { name: 'catalog', port: localServicePorts.catalog };
  assert.deepEqual(readServiceConfig({}, defaults), {
    name: 'catalog',
    port: 4001,
    host: '127.0.0.1',
  });
  assert.equal(readServiceConfig({ PORT: '4500' }, defaults).port, 4500);
  assert.equal(localServiceOrigin('catalog'), 'http://127.0.0.1:4001');
  for (const port of ['0', '-1', '65536', 'not-a-port', '', '123.5']) {
    assert.throws(() => readServiceConfig({ PORT: port }, defaults));
  }
  assert.throws(() => readServiceConfig({ HOST: ' ' }, defaults));
});

test('AMQP services share the namespace default and boundary checks', () => {
  assert.equal(messageNamespaceSchema.parse(undefined), 'eventflow');
  assert.equal(messageNamespaceSchema.parse('eventflow-test'), 'eventflow-test');
  assert.ok(messageNamespaceSchema.safeParse('a'.repeat(80)).success);
  for (const input of ['', 'a'.repeat(81), 'a:b', 'EventFlow'])
    assert.equal(messageNamespaceSchema.safeParse(input).success, false);
});

test('boots a real Nest server with isolated service identity and closes its listener', async () => {
  class TestModule {}
  Module({ imports: [HealthModule.forService('runtime-test')] })(TestModule);
  const app = await createApplication(TestModule);
  app.useLogger(false);
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    for (const route of ['live', 'ready']) {
      const response = await fetch(`${origin}/health/${route}`, {
        headers: { connection: 'close' },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok', service: 'runtime-test' });
    }
    const missing = await fetch(`${origin}/does-not-exist`, { headers: { connection: 'close' } });
    assert.equal(missing.status, 404);
    await missing.body.cancel();
  } finally {
    await app.close();
  }
});
