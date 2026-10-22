import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsFixture, fact } from '../helpers/analytics.mjs';
import { AnalyticsProjection } from '../../services/analytics/dist/projection.js';
test('projection survives duplicate delivery, lost insert ACK, recreation and atomic rebuild', async () => {
  const f = await analyticsFixture();
  try {
    const projection = new AnalyticsProjection(f.journal, f.engine),
      a = fact(),
      b = fact({ occurredAt: '2026-11-08T08:00:00.000Z' });
    await f.journal.append([a, b]);
    const original = f.engine.insert.bind(f.engine);
    let fail = true;
    f.engine.insert = async (...args) => {
      await original(...args);
      if (fail) {
        fail = false;
        throw new Error('lost ACK');
      }
    };
    await assert.rejects(projection.sync());
    assert.equal(await f.journal.checkpoint(), null);
    await projection.sync();
    assert.equal((await projection.status()).pending, 0);
    assert.equal(
      Number((await f.engine.rows('SELECT count() AS n FROM ' + f.engine.table() + ' FINAL'))[0].n),
      2,
    );
    const old = await f.engine.generation();
    await f.engine.command('DROP TABLE ' + f.engine.table() + ' SYNC');
    await projection.sync();
    assert.notEqual(await f.engine.generation(), old);
    const before = await f.engine.generation();
    await projection.rebuild();
    assert.notEqual(await f.engine.generation(), before);
    assert.equal(
      Number((await f.engine.rows('SELECT count() AS n FROM ' + f.engine.table() + ' FINAL'))[0].n),
      2,
    );
    const added = fact();
    await f.journal.append([added]);
    assert.equal((await projection.status()).stale, true);
    await projection.sync();
    assert.equal((await projection.status()).stale, false);
  } finally {
    await f.close();
  }
});
test('parallel exporters share a session lock while journal writes remain independent', async () => {
  const f = await analyticsFixture();
  try {
    const p = new AnalyticsProjection(f.journal, f.engine);
    const result = await f.journal.lock(180020, async () => {
      await f.journal.append([fact()]);
      assert.equal(await p.sync(), null);
      return true;
    });
    assert.equal(result, true);
    await p.sync();
    assert.equal((await p.status()).pending, 0);
  } finally {
    await f.close();
  }
});
