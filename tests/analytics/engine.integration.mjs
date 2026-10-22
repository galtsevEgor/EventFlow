import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsFixture, fact } from '../helpers/analytics.mjs';
import { readAnalyticsConfig } from '../../services/analytics/dist/config.js';
test('ClickHouse FINAL deduplicates retries before merges and keeps tenant/event keys separate', async () => {
  const f = await analyticsFixture();
  try {
    await f.engine.initialize();
    await f.engine.command('SYSTEM STOP MERGES ' + f.engine.table());
    const a = fact(),
      b = fact();
    await f.engine.insert([
      { sequence: '1', fact: a },
      { sequence: '2', fact: b },
    ]);
    await f.engine.insert([{ sequence: '1', fact: a }]);
    const raw = await f.engine.rows('SELECT count() AS n FROM ' + f.engine.table());
    const unique = await f.engine.rows('SELECT count() AS n FROM ' + f.engine.table() + ' FINAL');
    assert.equal(Number(raw[0].n), 3);
    assert.equal(Number(unique[0].n), 2);
    const generation = await f.engine.generation();
    assert.match(generation, /^[a-f0-9-]{36}$/);
    for (const CLICKHOUSE_URL of [
      'https://example.org',
      'http://user:password@localhost:8123',
      'http://localhost:8123/path',
    ])
      assert.throws(() => readAnalyticsConfig({ ...f.env, CLICKHOUSE_URL }));
  } finally {
    await f.close();
  }
});
test('owned journal is atomic, durable, idempotent and rejects same-key mutations', async () => {
  const f = await analyticsFixture();
  try {
    const a = fact();
    await Promise.all([f.journal.append([a]), f.journal.append([a])]);
    assert.equal((await f.journal.rows('0')).length, 1);
    await assert.rejects(
      f.journal.append([fact(), { ...a, kind: 'event_view' }]),
      (error) => error.status === 409,
    );
    assert.equal((await f.journal.rows('0')).length, 1);
    const [one, two] = await Promise.all([f.journal.append([fact()]), f.journal.append([fact()])]);
    assert.equal(one, two);
    assert.equal((await f.journal.rows('0')).length, 3);
  } finally {
    await f.close();
  }
});
