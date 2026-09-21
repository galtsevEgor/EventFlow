import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fullStack } from '../e2e/fixture.mjs';
import { publicCatalogFixture } from '../helpers/public-catalog.mjs';
import { toolPath } from '../../scripts/quality-tools.mjs';

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === '--smoke'),
  'Use test:overload [--smoke]',
);
const smoke = args[0] === '--smoke';
const directory = resolve('work/overload', randomUUID());
mkdirSync(directory, { recursive: true });
let stack, fixture, child;
try {
  stack = await fullStack();
  fixture = await publicCatalogFixture(stack);
  assert.match(await (await fetch(stack.origin + '/')).text(), /EF-111 synthetic event 11/);
  child = spawn(toolPath('k6'), ['run', '--quiet', 'tests/load/storefront.k6.js'], {
    env: {
      ...process.env,
      K6_NO_USAGE_REPORT: 'true',
      EVENTFLOW_LOAD_ORIGIN: stack.origin,
      PROFILE: smoke ? 'smoke' : 'peak',
      RESULT: resolve(directory, 'result.json'),
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0, 'k6 correctness or generator thresholds failed');
  const { metrics } = JSON.parse(readFileSync(resolve(directory, 'result.json'), 'utf8'));
  const count = (key) => metrics[key]?.values.count ?? 0;
  assert.ok(count('successful_responses') > 0, 'No successful responses');
  if (!smoke)
    assert.ok(
      count('limited_responses') + count('busy_responses') > 0,
      'Peak did not exercise admission',
    );
  const result = {
    directory,
    profile: smoke ? 'smoke' : 'peak',
    node: process.version,
    path: 'gateway -> SSR -> BFF -> Catalog -> PostgreSQL, plus gateway -> BFF API',
    fixture: '12 synthetic published events in an owned local database',
    cpuLimits: 'Windows processes on the same host, no fixed CPU quotas',
    sent: count('http_reqs'),
    dropped: count('dropped_iterations'),
    successful: count('successful_responses'),
    limited: count('limited_responses'),
    busy: count('busy_responses'),
    degraded: count('degraded_pages'),
    unexpected: count('unexpected_responses'),
    duration: metrics.http_req_duration.values,
    successfulDuration: metrics.successful_latency?.values,
  };
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (child?.exitCode === null) child.kill();
  await fixture?.close();
  await stack?.close();
}
