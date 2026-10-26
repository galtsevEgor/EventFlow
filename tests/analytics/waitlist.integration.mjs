import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { analyticsFixture } from '../helpers/analytics.mjs';
import { message } from '../../packages/event-contracts/dist/index.js';
import { BookingAnalytics } from '../../services/analytics/dist/booking.js';
import { AnalyticsProjection } from '../../services/analytics/dist/projection.js';
import { WaitlistReport } from '../../services/analytics/dist/waitlist-report.js';
test('waitlist cohorts survive out-of-order delivery, duplicates and rebuild without exposing contacts', async () => {
  const f = await analyticsFixture(),
    org = randomUUID(),
    sale = randomUUID(),
    id = randomUUID(),
    order = randomUUID();
  try {
    const ingest = new BookingAnalytics(f.journal),
      projection = new AnalyticsProjection(f.journal, f.engine),
      report = new WaitlistReport(f.engine, projection);
    const events = ['WAITING', 'OFFERED', 'PURCHASED'].map((state, i) =>
      message('waitlist', 'WaitlistChanged.v1', id, i + 1, {
        entryId: id,
        saleId: sale,
        organizationId: org,
        state,
        orderId: i ? order : null,
        occurredAt: '2026-11-10T10:0' + i + ':00.000Z',
      }),
    );
    for (const e of [events[2], events[1], events[0], events[1], events[2]]) await ingest.handle(e);
    await projection.sync();
    const period = { from: '2026-11-10', to: '2026-11-10', eventId: sale },
      result = await report.read(org, period);
    assert.deepEqual(
      [result.joined, result.offered, result.purchased, result.conversion, result.offerConversion],
      [1, 1, 1, 1, 1],
    );
    const other = await report.read(randomUUID(), period);
    assert.deepEqual([other.joined, other.conversion, other.offerConversion], [0, null, null]);
    await projection.rebuild();
    assert.equal((await report.read(org, period)).purchased, 1);
    await assert.rejects(
      () => ingest.handle({ ...events[0], producer: 'booking' }),
      /Invalid waitlist/,
    );
    await assert.rejects(() =>
      ingest.handle({ ...events[0], data: { ...events[0].data, email: 'private@eventflow.test' } }),
    );
    const facts = await f.journal.pool.query('SELECT fact FROM analytics_event');
    assert.equal(facts.rows.length, 3);
    assert.ok(
      facts.rows.every((r) => r.fact.sessionId === null && !JSON.stringify(r).includes('buyer')),
    );
  } finally {
    await f.close();
  }
});
