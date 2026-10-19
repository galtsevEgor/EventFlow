import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { searchFixture } from '../helpers/search.mjs';
import { seedSearchLoad } from '../helpers/search-load.mjs';
import { toolPath } from '../../scripts/quality-tools.mjs';
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && ['--smoke', '--stress'].includes(args[0])),
  'Use test:search-load [--smoke|--stress]',
);
const smoke = args[0] === '--smoke',
  count = smoke ? 300 : 30000,
  directory = resolve('work/search-load', randomUUID());
const profile = smoke ? 'smoke' : args[0] === '--stress' ? 'stress' : 'comparison';
mkdirSync(directory, { recursive: true });
process.env.EVENTFLOW_LOG_REQUESTS = '0';
const compose = [
  'compose',
  '--project-directory',
  '.',
  '--env-file',
  '.env',
  '-f',
  'infra/compose/compose.yaml',
];
const docker = (args) =>
  execFileSync('docker', args, { encoding: 'utf8', windowsHide: true }).trim();
const limits = [];
const failures = [];
let fixture, child;
try {
  for (const service of ['postgres', 'opensearch']) {
    const id = docker([...compose, 'ps', '-q', service]);
    assert.match(id, /^[a-f0-9]{12,64}$/);
    const previous = docker(['exec', id, 'cat', '/sys/fs/cgroup/cpu.max']);
    assert.match(previous, /^(max|\d+) \d+$/);
    if (previous !== '100000 100000') {
      limits.push({ id, previous, service });
      docker(['update', '--cpu-period=100000', '--cpu-quota=100000', id]);
    }
  }
  fixture = await searchFixture({ rabbit: true });
  const app = await fixture.start();
  const control = await seedSearchLoad(fixture, app, count);
  const worker = await fixture.start({ workers: true });
  const queries = [
    { q: 'Концерт', sort: 'date' },
    { q: 'бета', city: 'Бельцы', sort: 'price_asc' },
    { q: 'Концерт', minPriceMinor: '2000', maxPriceMinor: '3500', sort: 'price_desc' },
    { q: 'Концерт', from: '2035-06-10', to: '2035-07-10', page: '2', pageSize: '12', sort: 'date' },
  ];
  const cases = [];
  for (const query of queries) {
    const params = new URLSearchParams(query).toString();
    const [indexed, literal] = await Promise.all([
      fetch(app.origin + '/api/v1/search/events?' + params).then((r) => r.json()),
      fetch(fixture.catalog.origin + '/api/v1/search/fallback?' + params).then((r) => r.json()),
    ]);
    assert.equal(indexed.source, 'search');
    assert.equal(literal.source, 'catalog');
    assert.equal(indexed.total, literal.total);
    assert.deepEqual(indexed.events, literal.events);
    assert.deepEqual(indexed.facets, literal.facets);
    cases.push({
      query: params,
      total: indexed.total,
      ids: indexed.events.map((event) => event.id),
    });
    for (let warmup = 0; warmup < 2; warmup++)
      await Promise.all([
        fetch(app.origin + '/api/v1/search/events?' + params).then((r) => r.body.cancel()),
        fetch(fixture.catalog.origin + '/api/v1/search/fallback?' + params).then((r) =>
          r.body.cancel(),
        ),
      ]);
  }
  child = spawn(toolPath('k6'), ['run', '--quiet', 'tests/load/search.k6.js'], {
    env: {
      ...process.env,
      K6_NO_USAGE_REPORT: 'true',
      PROFILE: profile,
      SEARCH_ORIGIN: app.origin,
      CATALOG_ORIGIN: fixture.catalog.origin,
      SEARCH_CASES: JSON.stringify(cases),
      RESULT: resolve(directory, 'result.json'),
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  const [code] = await once(child, 'exit');
  const lag = [];
  for (let sample = 0; code === 0 && sample < (smoke ? 2 : 5); sample++) {
    const description = 'Контроль задержки индекса ' + sample,
      started = performance.now();
    const saved = await fixture.catalog.request(control.path, control.token, 'PATCH', {
      title: control.title,
      description,
    });
    assert.equal(saved.status, 200);
    for (;;) {
      const response = await fetch(
        app.origin +
          '/api/v1/search/events?q=' +
          encodeURIComponent('Контроль задержки индекса ' + sample),
      );
      const page = await response.json();
      if (
        page.events?.some(
          (event) => event.id === control.eventId && event.description === description,
        )
      )
        break;
      assert.ok(performance.now() - started < 15000, 'Committed event did not become searchable');
      await delay(100);
    }
    lag.push(Math.round(performance.now() - started));
  }
  await worker.store.ready();
  const { metrics } = JSON.parse(readFileSync(resolve(directory, 'result.json'), 'utf8'));
  const result = {
    directory,
    profile,
    arrivalRatePerSecond: profile === 'stress' ? 25 : 5,
    k6ExitCode: code,
    node: process.version,
    documents: count + 1,
    resources:
      'PostgreSQL and OpenSearch each capped at 1 CPU; same fixed resource configuration for both passes. OpenSearch 512MiB heap/1536MiB limit. Node and k6 share the Windows host.',
    comparison:
      'Identical literal queries, filters, sorts, exact totals and result IDs, warm caches; SQL first then OpenSearch. This is a local comparison, not a production capacity estimate.',
    sql: metrics.sql_latency.values,
    search: metrics.search_latency.values,
    requests: metrics.http_reqs.values.count,
    dropped: metrics.dropped_iterations?.values.count ?? 0,
    errors: metrics.search_errors.values.count,
    errorsByEngine: {
      sql: metrics['search_errors{engine:sql}'].values.count,
      search: metrics['search_errors{engine:search}'].values.count,
    },
    committedChangeToSearchableMs: lag,
  };
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  assert.equal(
    code,
    0,
    'k6 correctness or generator threshold failed; measurements were preserved',
  );
} catch (error) {
  failures.push(error);
} finally {
  if (child?.exitCode === null) child.kill();
  try {
    await fixture?.close();
  } catch (error) {
    failures.push(error);
  }
  for (const { id, previous } of limits.reverse())
    try {
      const [quota, period] = previous.split(' ');
      docker([
        'update',
        '--cpu-period=' + period,
        '--cpu-quota=' + (quota === 'max' ? '-1' : quota),
        id,
      ]);
    } catch (error) {
      failures.push(error);
    }
}
if (failures.length)
  throw new AggregateError(failures, 'Search load check or fixture cleanup failed');
