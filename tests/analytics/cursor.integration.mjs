import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsFixture, fact } from '../helpers/analytics.mjs';
import { AnalyticsProjection } from '../../services/analytics/dist/projection.js';
test('numeric cursor crosses batch and digit boundaries without skipping committed facts', async () => {
  const f = await analyticsFixture();
  try {
    const rows = Array.from({ length: 2105 }, () => fact());
    await f.journal.append(rows.slice(0, 1000));
    await f.journal.append(rows.slice(1000));
    let after = '0',
      count = 0;
    for (;;) {
      const page = await f.journal.rows(after);
      if (!page.length) break;
      for (const row of page) {
        assert.ok(BigInt(row.sequence) > BigInt(after));
        after = row.sequence;
        count++;
      }
    }
    assert.equal(count, 2105);
    assert.equal(after, await f.journal.highWater());
    const p = new AnalyticsProjection(f.journal, f.engine);
    await p.sync();
    assert.equal(
      Number((await f.engine.rows('SELECT count() AS n FROM ' + f.engine.table() + ' FINAL'))[0].n),
      2105,
    );
  } finally {
    await f.close();
  }
});
