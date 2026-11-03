import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { initializeEnvironment } from './local-env.mjs';

test('initialization generates distinct secrets and preserves them on repeated runs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eventflow-env-'));
  try {
    initializeEnvironment(directory);
    const original = readFileSync(join(directory, '.env'), 'utf8');
    const env = parseEnv(original);
    assert.notEqual(env.CATALOG_DB_PASSWORD, env.BOOKING_DB_PASSWORD);
    assert.equal(new URL(env.BOOKING_DATABASE_URL).password, env.BOOKING_DB_PASSWORD);
    assert.equal(new URL(env.ANALYTICS_DATABASE_URL).password, env.ANALYTICS_DB_PASSWORD);
    assert.equal(new URL(env.WAITLIST_DATABASE_URL).password, env.WAITLIST_DB_PASSWORD);
    assert.equal(new URL(env.WAITLIST_DATABASE_URL).username, 'waitlist');
    assert.equal(
      new URL(env.RECOMMENDATIONS_DATABASE_URL).password,
      env.RECOMMENDATIONS_DB_PASSWORD,
    );
    assert.equal(new URL(env.RECOMMENDATIONS_DATABASE_URL).port, '26432');
    assert.equal(new URL(env.RECOMMENDATIONS_ADMIN_DATABASE_URL).username, 'recommendations_admin');
    assert.notEqual(env.RECOMMENDATIONS_DB_PASSWORD, env.RECOMMENDATIONS_ADMIN_PASSWORD);
    assert.notEqual(env.WAITLIST_CONTACT_KEY, env.BOOKING_CONTACT_KEY);
    assert.notEqual(env.ANALYTICS_SESSION_KEY, env.OIDC_CLIENT_SECRET);
    assert.match(env.CLICKHOUSE_PASSWORD, /^[a-f0-9]{64}$/);
    assert.match(env.TICKET_QR_KEYS, /^v1:[0-9a-f]{64}$/);
    assert.match(env.OFFLINE_CHECK_IN_KEY, /^[0-9a-f]{64}$/);
    assert.notEqual(env.OFFLINE_CHECK_IN_KEY, env.TICKET_QR_KEYS.slice(3));
    initializeEnvironment(directory);
    assert.equal(readFileSync(join(directory, '.env'), 'utf8'), original);
    const s3 = JSON.parse(readFileSync(join(directory, 'work/local/s3.json'), 'utf8'));
    assert.equal(s3.identities[0].credentials[0].secretKey, env.S3_SECRET_KEY);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an incomplete existing env fails without overwriting user settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eventflow-env-'));
  try {
    const original = 'CUSTOM_SETTING=keep-me\n';
    writeFileSync(join(directory, '.env'), original);
    assert.throws(() => initializeEnvironment(directory), /preserved/);
    assert.equal(readFileSync(join(directory, '.env'), 'utf8'), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
