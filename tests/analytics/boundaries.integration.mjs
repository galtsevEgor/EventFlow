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
    const lateSession = randomUUID();
    const lateOrder = randomUUID();
    const late = (kind, occurredAt) =>
      row(kind, occurredAt, { sessionId: lateSession, orderId: lateOrder });
    await f.journal.append([
      late('impression', '2026-11-09T23:59:59.999Z'),
      late('event_view', '2026-11-10T00:00:00.000Z'),
      late('held', '2026-11-10T00:00:01.000Z'),
      late('confirmed', '2026-11-10T23:59:59.998Z'),
      row('impression', '2026-11-10T00:00:00.000Z', { sessionId: randomUUID() }),
    ]);
    await p.sync();
    const result = await report.read(base.organizationId, { from: '2026-11-09', to: '2026-11-09' });
    assert.equal(result.current.impressions, 2);
    assert.equal(result.current.held, 2);
    assert.equal(result.current.confirmed, 1);
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

test('report accepts 10,000 groups and rejects a result that would truncate', async () => {
  const f = await analyticsFixture();
  try {
    const projection = new AnalyticsProjection(f.journal, f.engine);
    await projection.sync();
    const report = new AnalyticsReport(f.engine, projection);
    const organizationId = randomUUID();
    const period = { from: '2026-11-09', to: '2026-11-09' };
    await f.engine.command(
      `INSERT INTO ${f.engine.table()}
        (key,sequence,kind,organizationId,eventId,sessionId,occurredAt,source)
       SELECT toString(number),number+1,'impression',{org:String},
         toString(generateUUIDv4()),toString(generateUUIDv4()),toDateTime('2026-11-09 10:00:00','UTC'),'catalog'
       FROM numbers(10000)`,
      { org: organizationId },
    );
    assert.equal((await report.read(organizationId, period)).current.groups.length, 10_000);
    await f.engine.insert([{ sequence: '10001', fact: fact({ organizationId }) }]);
    await assert.rejects(report.read(organizationId, period), /Narrow the analytics period/);
  } finally {
    await f.close();
  }
});
