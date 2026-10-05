import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertExpansion,
  assertUpgrade,
  assertApplicationSchema,
  migrationHash,
  replaceApplication,
  withEnvironmentLock,
} from './release/compatibility.mjs';
import { decryptBackup, encryptBackup } from './release/backup.mjs';
import { alerts, traffic } from './release/traffic.mjs';
import { composeFiles, telemetrySettings } from './release/telemetry.mjs';

test('reviewed upgrades require exact SQL and forbid old applications after an incompatible expansion', () => {
  const baseline = new Map([['initial', 'CREATE TABLE "Baseline" (id UUID);']]);
  const sql = 'ALTER TYPE "OrderState" ADD VALUE \'REFUNDED\';';
  const expanded = new Map([...baseline, ['refunds', sql]]);
  const reviews = { refunds: { sha256: migrationHash(sql), backwardCompatible: false } };
  assert.throws(() => assertExpansion(baseline, expanded), /review/);
  assert.throws(() => assertUpgrade(baseline, expanded, {}), /review/);
  assert.throws(
    () => assertUpgrade(baseline, expanded, { refunds: { sha256: migrationHash(sql) } }),
    /review/,
  );
  assert.doesNotThrow(() => assertUpgrade(baseline, expanded, reviews));
  assert.throws(
    () =>
      assertUpgrade(
        baseline,
        new Map([...baseline, ['refunds', sql + ' DROP TABLE "Baseline";']]),
        reviews,
      ),
    /review/,
  );
  assert.throws(() => assertApplicationSchema(baseline, expanded, reviews), /cannot read/);
  assert.doesNotThrow(() => assertApplicationSchema(expanded, expanded, reviews));
  assert.throws(
    () => assertUpgrade(baseline, new Map([['initial', 'changed']]), reviews),
    /changed/,
  );
  assert.equal(migrationHash('one\r\ntwo'), migrationHash('one\ntwo'));
});

test('deployment lock excludes overlap and is released even after failure', async () => {
  const target = { name: 'fixture', directory: mkdtempSync(join(tmpdir(), 'eventflow-lock-')) };
  try {
    await assert.rejects(
      withEnvironmentLock(target, async () => {
        await assert.rejects(
          withEnvironmentLock(target, () => assert.fail('second writer entered')),
          /locked/,
        );
        throw new Error('migration failed');
      }),
      /migration failed/,
    );
    await withEnvironmentLock(target, () => true);
  } finally {
    rmSync(join(target.directory, 'deployment.lock'), { force: true });
    rmdirSync(target.directory);
  }
});

test('applied migrations are immutable and automatic rollback accepts only reviewed additive SQL forms', () => {
  const old = new Map([['init', 'CREATE TABLE baseline (id uuid);']]);
  const extend = (sql) => new Map([...old, ['next', sql]]);
  assert.doesNotThrow(() =>
    assertExpansion(old, extend('CREATE INDEX "age_idx" ON "Ticket" ("usedAt");')),
  );
  assert.doesNotThrow(() =>
    assertExpansion(old, extend('ALTER TABLE "Ticket" ADD COLUMN "note" TEXT;')),
  );
  assert.doesNotThrow(() =>
    assertExpansion(
      old,
      extend('ALTER TABLE "PaymentAttempt" ADD COLUMN traceparent varchar(55);'),
    ),
  );
  assert.throws(
    () =>
      assertExpansion(
        old,
        extend('ALTER TABLE "PaymentAttempt" ADD COLUMN traceparent varchar(55) NOT NULL;'),
      ),
    /review/,
  );
  assert.throws(
    () => assertExpansion(old, extend('ALTER TABLE "Ticket" DROP COLUMN "usedAt";')),
    /review/,
  );
  assert.throws(
    () => assertExpansion(old, extend('ALTER TABLE "Ticket" ADD COLUMN "required" TEXT NOT NULL;')),
    /review/,
  );
  assert.throws(() => assertExpansion(old, new Map([['init', 'changed']])), /changed/);
  assert.throws(() => assertExpansion(old, new Map()), /disappeared/);
});

test('release telemetry settings preserve secrets and sampling, replace prior endpoints and remain idempotent', () => {
  const source =
    '# local settings\nSECRET="synthetic-value"\nEVENTFLOW_TRACE_SAMPLE_RATIO=0.25\nEVENTFLOW_TELEMETRY_ENABLED=false\nOTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://old:4318/v1/traces\n';
  const enabled = telemetrySettings(source, 'staging', true);
  assert.ok(enabled.includes('SECRET="synthetic-value"'));
  assert.ok(enabled.includes('EVENTFLOW_TRACE_SAMPLE_RATIO=0.25'));
  assert.ok(enabled.includes('http://collector:4318/v1/traces'));
  assert.ok(!enabled.includes('http://old'));
  assert.equal(enabled.match(/EVENTFLOW_TELEMETRY_ENABLED=/g).length, 1);
  assert.equal(telemetrySettings(enabled, 'staging', true), enabled);
  assert.ok(
    telemetrySettings(enabled, 'staging', false).includes('EVENTFLOW_TELEMETRY_ENABLED=false'),
  );
  assert.throws(() => telemetrySettings(source, 'recovery', true));
});

test('only telemetry-enabled releases require the external observability network', () => {
  assert.deepEqual(composeFiles({}), ['infra/compose/compose.yaml', 'infra/release/compose.yaml']);
  assert.deepEqual(composeFiles({ EVENTFLOW_TELEMETRY_ENABLED: 'false' }), composeFiles({}));
  assert.deepEqual(composeFiles({ EVENTFLOW_TELEMETRY_ENABLED: 'true' }), [
    ...composeFiles({}),
    'infra/release/observability.yaml',
  ]);
});

test('smoke failure returns the release error even after the previous app has recovered', async () => {
  const events = [];
  await assert.rejects(
    replaceApplication(
      async () => {
        events.push('candidate');
        throw new Error('smoke failed');
      },
      async () => {
        events.push('previous');
      },
    ),
    /smoke failed/,
  );
  assert.deepEqual(events, ['candidate', 'previous']);
});

test('backup entries authenticate their bytes and their intended archive path', () => {
  const key = randomBytes(32);
  const data = Buffer.from('synthetic restore data');
  const archive = encryptBackup(key, 'archive/booking.dump', data);
  assert.deepEqual(decryptBackup(key, 'archive/booking.dump', archive), data);
  assert.notDeepEqual(encryptBackup(key, 'archive/booking.dump', data), archive);
  assert.throws(() => decryptBackup(key, 'archive/tickets.dump', archive));
  assert.throws(() => decryptBackup(randomBytes(32), 'archive/booking.dump', archive));
  archive[archive.length - 1] ^= 1;
  assert.throws(() => decryptBackup(key, 'archive/booking.dump', archive));
});

test('traffic samples report p95 and errors, and expire outside their window', () => {
  let now = 0;
  const samples = traffic(() => now);
  for (let duration = 1; duration <= 20; duration++) {
    samples.observe(duration === 20 ? 503 : 200, duration);
  }
  assert.deepEqual(samples.snapshot(), { requests: 20, serverErrors: 1, p95Ms: 19 });
  now = 300_001;
  assert.deepEqual(samples.snapshot(), { requests: 0, serverErrors: 0, p95Ms: 0 });
});

test('monitor reports outage, backlog, stale payments, refunds and API degradation', () => {
  const healthy = { web: {}, rabbitmq: {}, catalog: {}, booking: {}, payments: {}, tickets: {} };
  assert.deepEqual(alerts(healthy), []);
  const impaired = {
    ...healthy,
    web: { requests: 20, serverErrors: 2, p95Ms: 850 },
    rabbitmq: { dead: 1, pending: 101 },
    catalog: { outboxAgeSeconds: 61, lockWaiters: 1 },
    booking: null,
    payments: { paymentAgeSeconds: 301, refundAgeSeconds: 301 },
    tickets: { mailDead: 1 },
  };
  assert.deepEqual(alerts(impaired), [
    'BOOKING_UNAVAILABLE',
    'RABBIT_DLQ',
    'RABBIT_BACKLOG',
    'CATALOG_OUTBOX_STALLED',
    'CATALOG_LOCK_WAIT',
    'TICKETS_MAIL_DEAD',
    'PAYMENT_STALLED',
    'REFUND_STALLED',
    'HTTP_5XX',
    'HTTP_LATENCY',
  ]);
});
