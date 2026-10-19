import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanBroker } from '../tests/helpers/broker.mjs';
import { searchEngineFixture } from '../tests/helpers/opensearch.mjs';
import { IndexStore } from '../services/search/dist/index-store.js';

const probeOptions = { headers: { connection: 'close' } };

async function availablePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function checkProcess(name, directory, args, route, verify, overrides = {}) {
  const port = await availablePort();
  const child = spawn(process.execPath, args(port), {
    cwd: resolve(directory),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NEXT_TELEMETRY_DISABLED: '1',
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-6000);
  });
  child.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-6000);
  });
  const closed = new Promise((done) => child.once('close', done));
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error(`${name} exited early: ${output}`);
      let response;
      try {
        response = await fetch(origin + route, {
          ...probeOptions,
          signal: AbortSignal.timeout(1000),
        });
      } catch {
        await delay(250);
        continue;
      }
      assert.equal(response.status, 200, `${name} returned ${response.status}`);
      await verify(response, origin);
      console.log(`Smoke passed: ${name}`);
      return;
    }
    throw new Error(`${name} did not become ready: ${output}`);
  } finally {
    child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(deadline);
    }
  }
}

const smokeNamespace = `eventflow-test-${randomUUID()}`;
try {
  for (const [name, group] of [
    ['bff', 'apps'],
    ...['catalog', 'booking', 'payments', 'tickets'].map((name) => [name, 'services']),
  ]) {
    await checkProcess(
      name,
      `${group}/${name}`,
      () => ['dist/main.js'],
      '/health/ready',
      async (response) => {
        assert.deepEqual(await response.json(), { status: 'ok', service: name });
      },
      { MESSAGE_NAMESPACE: smokeNamespace },
    );
  }
} finally {
  await cleanBroker(smokeNamespace);
}

const searchFixture = searchEngineFixture();
try {
  const index = await searchFixture.engine.ensure(),
    store = new IndexStore(searchFixture.engine);
  await store.initialize();
  await store.save(index, 0, true);
  await checkProcess(
    'search',
    'services/search',
    () => ['dist/main.js'],
    '/health/ready',
    async (response, origin) => {
      assert.deepEqual(await response.json(), { status: 'ok', service: 'search' });
      const result = await fetch(origin + '/api/v1/search/events', probeOptions);
      assert.equal(result.status, 200);
      const page = await result.json();
      assert.equal(page.source, 'search');
      assert.equal(page.total, 0);
    },
    { EVENTFLOW_WORKLOAD: 'http', SEARCH_INDEX_NAMESPACE: searchFixture.namespace },
  );
} finally {
  await searchFixture.close();
}

await checkProcess(
  'storefront',
  'apps/storefront',
  (port) => [
    'node_modules/next/dist/bin/next',
    'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  '/',
  async (response, origin) => {
    const html = await response.text();
    assert.match(html, /EventFlow/);
    assert.match(html, /<html lang="ru"/);
    const asset = html.match(/href="([^"]+\.css[^"]*)"/)[1];
    const responseAsset = await fetch(origin + asset, probeOptions);
    assert.equal(responseAsset.status, 200);
    await responseAsset.body.cancel();
  },
);

await checkProcess(
  'organizer',
  'apps/organizer',
  (port) => [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  '/organizer/',
  async (response, origin) => {
    const html = await response.text();
    assert.match(html, /EventFlow/);
    const asset = html.match(/src="([^"]+\.js)"/)[1];
    assert.match(asset, /^\/organizer\/assets\//);
    const responseAsset = await fetch(origin + asset, probeOptions);
    assert.equal(responseAsset.status, 200);
    await responseAsset.body.cancel();
  },
);
