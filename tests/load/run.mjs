import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { catalogFixture } from '../../services/catalog/tests/fixture.mjs';
import { bookingFixture } from '../helpers/booking.mjs';
import { bookingReplica } from '../helpers/booking-replica.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { testIdentity } from '../helpers/identity.mjs';
import { seedLoad } from './seed.mjs';
import { observe, machine } from './observe.mjs';
import { toolPath } from '../../scripts/quality-tools.mjs';

process.env.EVENTFLOW_LOG_REQUESTS = '0';
for (const name of ['CATALOG_DATABASE_URL', 'BOOKING_DATABASE_URL', 'AMQP_URL']) {
  const url = new URL(process.env[name]);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error(`${name} must use loopback for load fixtures`);
}
const [profile, ...extra] = process.argv.slice(2);
if (extra.length || (profile && !['--smoke', '--peak', '--peak-replicas'].includes(profile)))
  throw new Error('Use pnpm test:load [--smoke|--peak|--peak-replicas]');
const smoke = profile === '--smoke';
const peak = profile === '--peak' || profile === '--peak-replicas';
const replicas = profile === '--peak-replicas' ? 3 : 1;
const poolSize = 12 / replicas;
const peers = [];
const duration = smoke ? 10 : peak ? 70 : 600,
  runId = randomUUID(),
  namespace = `eventflow-test-${runId}`;
const directory = resolve('work/load', runId);
mkdirSync(directory, { recursive: true });
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
let catalog, booking, identity, stop, child;
const failures = [];
const fixturePath = resolve(directory, 'fixture.json');
const tokensPath = resolve(directory, 'tokens.json');
function sourceFingerprint() {
  const hash = createHash('sha256');
  const paths = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  for (const path of [...new Set(paths)].sort())
    hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}
try {
  identity = await testIdentity();
  catalog = await catalogFixture();
  booking = await bookingFixture(namespace, 0, {
    OIDC_ISSUER: identity.issuer,
    DATABASE_POOL_SIZE: poolSize,
  });
  for (let replica = 1; replica < replicas; replica++) {
    peers.push(await bookingReplica(booking.databaseUrl, namespace, identity.issuer, poolSize));
  }
  const bookingOrigins = [booking.origin, ...peers.map((peer) => peer.origin)];
  const seed = await seedLoad(catalog, booking, identity, smoke);
  const { tokens, ...configuration } = seed;
  writeFileSync(
    fixturePath,
    JSON.stringify({
      ...configuration,
      runId,
      duration,
      catalog: catalog.origin,
      booking: bookingOrigins,
      peak,
    }),
    { mode: 0o600 },
  );
  writeFileSync(tokensPath, JSON.stringify(tokens), { mode: 0o600 });
  const metadata = {
    runId,
    profile: profile?.slice(2) ?? 'baseline',
    durationSeconds: duration,
    rates: { catalog: 50, reserve: peak ? [5, 15, 30, 5] : 5 },
    booking: { replicas, poolSize },
    fixture: seed.shape,
    git: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceSha256: sourceFingerprint(),
    machine: machine(replicas),
    startedAt: new Date().toISOString(),
    warmup: '10 seconds of catalog, sale and authenticated order reads; excluded from k6 results',
  };
  write(resolve(directory, 'environment.json'), metadata);
  for (let i = 0; i < 10; i++) {
    await Promise.all(
      [
        fetch(catalog.origin + '/api/v1/events'),
        ...bookingOrigins.map((origin) => fetch(origin + `/api/v1/sales/${seed.sales[0]}`)),
        fetch(booking.origin + '/api/v1/orders', {
          headers: { authorization: `Bearer ${seed.tokens[0]}` },
        }),
      ].map(async (promise) => (await promise).body?.cancel()),
    );
    await delay(1000);
  }
  booking.db.resetQueryMetrics();
  stop = await observe(booking, directory, write);
  console.log(
    `Starting ${metadata.profile}: ${duration}s, 50 catalog + ${peak ? '5 to 30' : 5} reserve requests/s across ${replicas} Booking replica(s).`,
  );
  const summaryPath = resolve(directory, 'k6-summary.json');
  child = spawn(toolPath('k6'), ['run', '--quiet', '--no-color', 'tests/load/booking.k6.js'], {
    env: {
      ...process.env,
      EVENTFLOW_LOAD_FIXTURE: fixturePath,
      EVENTFLOW_LOAD_TOKENS: tokensPath,
      EVENTFLOW_LOAD_SUMMARY: summaryPath,
      K6_NO_USAGE_REPORT: 'true',
    },
    windowsHide: true,
    stdio: 'inherit',
  });
  const exit = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  const stopObservation = stop;
  stop = undefined;
  const samples = await stopObservation();
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const [invariants] = await booking.db.$queryRaw`
    SELECT
      (SELECT count(*)::int FROM "Order" o WHERE o."buyerSubject" LIKE 'load-buyer-%' AND NOT EXISTS (SELECT 1 FROM "OrderItem" i WHERE i."orderId"=o.id)) AS empty_orders,
      (SELECT count(*)::int FROM "Order" o WHERE o."totalMinor" != (SELECT sum(i."priceMinor") FROM "OrderItem" i WHERE i."orderId"=o.id)) AS wrong_totals,
      (SELECT count(*)::int FROM "SeatInventory" s JOIN "Order" o ON o.id=s."currentOrderId" WHERE s.state='HELD' AND (o.state!='HELD' OR s."expiresAt"!=o."expiresAt")) AS invalid_holds
  `;
  assert.deepEqual(invariants, { empty_orders: 0, wrong_totals: 0, invalid_holds: 0 });
  const report = {
    profile: metadata.profile,
    exitCode: exit,
    invariants,
    metrics: summary.metrics,
    diagnostics: {
      samples: samples.length,
      maxPoolWaiting: Math.max(0, ...samples.map((s) => s.pool.waiting)),
      maxPoolConnections: Math.max(0, ...samples.map((s) => s.pool.total)),
      maxLockWaiters: Math.max(0, ...samples.map((s) => s.lock_waiters)),
      maxBookingSessions: Math.max(0, ...samples.map((s) => s.sessions)),
      queries: booking.db.diagnostics().queries,
    },
  };
  write(resolve(directory, 'result.json'), report);
  console.log(
    JSON.stringify(
      {
        directory,
        exitCode: exit,
        reserve: summary.metrics.reserve_ms?.values,
        catalog: summary.metrics.catalog_ms?.values,
        ...report.diagnostics,
      },
      null,
      2,
    ),
  );
  assert.equal(exit, 0, 'k6 checks/throughput thresholds failed; inspect the local report');
} catch (error) {
  failures.push(error);
} finally {
  if (child?.exitCode === null) child.kill();
  const observation = await Promise.allSettled([stop?.()]);
  for (const path of [tokensPath, fixturePath]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') failures.push(error);
    }
  }
  const peerCleanup = await Promise.allSettled(peers.map((peer) => peer.close()));
  const cleanup = await Promise.allSettled([booking?.close(), catalog?.close(), identity?.close()]);
  const broker = await Promise.allSettled([cleanBroker(namespace)]);
  for (const result of [...observation, ...peerCleanup, ...cleanup, ...broker])
    if (result.status === 'rejected') failures.push(result.reason);
}
if (failures.length)
  throw new AggregateError(failures, 'Load run failed; local diagnostics were retained.');
