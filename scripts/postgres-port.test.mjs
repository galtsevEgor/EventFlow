import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { initializeEnvironment } from './local-env.mjs';
import { configurePostgresPort } from './postgres-port.mjs';
test('changing a reserved local port preserves secrets, database names and repeated configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eventflow-port-'));
  try {
    initializeEnvironment(directory);
    const path = join(directory, '.env'),
      before = parseEnv(readFileSync(path, 'utf8'));
    configurePostgresPort(directory, 25432);
    const source = readFileSync(path, 'utf8'),
      after = parseEnv(source);
    assert.equal(after.POSTGRES_PORT, '25432');
    for (const name of ['CATALOG', 'BOOKING', 'PAYMENTS', 'TICKETS']) {
      const old = new URL(before[`${name}_DATABASE_URL`]),
        current = new URL(after[`${name}_DATABASE_URL`]);
      old.port = '25432';
      assert.equal(current.href, old.href);
      assert.equal(after[`${name}_DB_PASSWORD`], before[`${name}_DB_PASSWORD`]);
    }
    assert.equal(after.OIDC_CLIENT_SECRET, before.OIDC_CLIENT_SECRET);
    configurePostgresPort(directory, 25432);
    assert.equal(readFileSync(path, 'utf8'), source);
    for (const port of [0, 80, 65536, 'unsafe'])
      assert.throws(() => configurePostgresPort(directory, port));
    assert.equal(readFileSync(path, 'utf8'), source);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
