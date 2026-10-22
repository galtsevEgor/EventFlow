import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { analyticsFixture, fact } from '../helpers/analytics.mjs';
import { AnalyticsProjection } from '../../services/analytics/dist/projection.js';
import { AnalyticsReport } from '../../services/analytics/dist/report.js';
test('funnel excludes steps at the exact 24-hour boundary, unattributed orders and earlier views', async () => {
  const f = await analyticsFixture();
  try {
    const p = new AnalyticsProjection(f.journal, f.engine),
      report = new AnalyticsReport(f.engine, p);
    const base = fact({ source: 'search' }),
      orderId = randomUUID();
    const row = (kind, time, extra = {}) =>
      fact({ ...base, key: randomUUID(), kind, occurredAt: time, ...extra });
    await f.journal.append([
      row('impression', '2026-11-09T10:00:00.000Z'),
      row('impression', '2026-11-09T10:00:01.000Z', { source: 'direct' }),
      row('event_view', '2026-11-09T10:01:00.000Z'),
      row('held', '2026-11-09T10:02:00.000Z', { orderId }),
      row('confirmed', '2026-11-10T10:00:00.000Z', { orderId }),
      row('confirmed', '2026-11-09T10:04:00.000Z', { orderId: randomUUID(), sessionId: null }),
    ]);
    await p.sync();
    const result = await report.read(base.organizationId, { from: '2026-11-09', to: '2026-11-09' });
    assert.equal(result.current.held, 1);
    assert.equal(result.current.confirmed, 0);
    assert.equal(
      (
        await report.read(base.organizationId, {
          from: '2026-11-09',
          to: '2026-11-09',
          source: 'direct',
        })
      ).current.impressions,
      0,
    );
    const searchId = randomUUID(),
      search = fact({
        key: 'search:' + searchId,
        kind: 'search',
        searchId,
        organizationId: null,
        eventId: null,
        sessionId: null,
        source: 'search',
        resultCount: 0,
      });
    await f.journal.append([search, search]);
    await p.sync();
    const quality = await report.search({ from: '2026-11-09', to: '2026-11-09' });
    assert.equal(quality.searches, 1);
    assert.equal(quality.emptyRate, 1);
  } finally {
    await f.close();
  }
});
