import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { analyticsFixture, fact } from '../helpers/analytics.mjs';
import { AnalyticsProjection } from '../../services/analytics/dist/projection.js';
import { AnalyticsReport } from '../../services/analytics/dist/report.js';
import { BookingAnalytics } from '../../services/analytics/dist/booking.js';
import { message } from '../../packages/event-contracts/dist/index.js';
test('ClickHouse funnel isolates tenants, ordered same-order steps, late arrivals and previous period', async () => {
  const f = await analyticsFixture();
  try {
    const p = new AnalyticsProjection(f.journal, f.engine),
      report = new AnalyticsReport(f.engine, p);
    const base = fact({ source: 'search' }),
      orderId = randomUUID();
    const step = (kind, minute, extra = {}) =>
      fact({
        ...base,
        key: randomUUID(),
        kind,
        occurredAt: '2026-11-09T10:' + String(minute).padStart(2, '0') + ':00.000Z',
        ...extra,
      });
    const rows = [
      step('impression', 0),
      step('event_view', 1),
      step('held', 2, { orderId, source: 'booking' }),
      step('confirmed', 3, { orderId, source: 'booking' }),
      step('search_click', 1),
      step('impression', 4), // same session/event is one funnel entry
      step('confirmed', 1, { orderId: randomUUID(), sessionId: randomUUID() }),
      fact({ kind: 'impression' }), // another tenant
      fact({
        ...base,
        key: randomUUID(),
        kind: 'impression',
        occurredAt: '2026-11-08T10:00:00.000Z',
      }),
    ];
    await f.journal.append(rows);
    await p.sync();
    const result = await report.read(base.organizationId, { from: '2026-11-09', to: '2026-11-09' });
    assert.deepEqual(
      [
        result.current.impressions,
        result.current.views,
        result.current.held,
        result.current.confirmed,
        result.current.ctr,
      ],
      [1, 1, 1, 1, 1],
    );
    assert.equal(result.previous.impressions, 1);
    assert.equal(result.previous.confirmed, 0);
    const second = randomUUID(),
      order2 = randomUUID();
    await f.journal.append([
      step('impression', 5, { sessionId: second }),
      step('event_view', 6, { sessionId: second }),
      step('held', 7, { sessionId: second, orderId: order2 }),
      step('confirmed', 8, { sessionId: second, orderId: randomUUID() }),
    ]);
    await p.sync();
    assert.equal(
      (await report.read(base.organizationId, { from: '2026-11-09', to: '2026-11-09' })).current
        .confirmed,
      1,
    );
    await f.journal.append([step('confirmed', 8, { sessionId: second, orderId: order2 })]);
    await p.sync();
    assert.equal(
      (await report.read(base.organizationId, { from: '2026-11-09', to: '2026-11-09' })).current
        .confirmed,
      2,
    );
    const empty = await report.read(randomUUID(), { from: '2026-11-09', to: '2026-11-09' });
    assert.equal(empty.current.conversion, null);
  } finally {
    await f.close();
  }
});
test('Booking snapshots derive immutable held/confirmed facts and ignore client payment claims', async () => {
  const f = await analyticsFixture();
  try {
    const handler = new BookingAnalytics(f.journal),
      orderId = randomUUID(),
      saleId = randomUUID(),
      organizationId = randomUUID(),
      analyticsSessionId = randomUUID();
    const data = {
      orderId,
      saleId,
      organizationId,
      analyticsSessionId,
      state: 'HELD',
      seatCount: 1,
      totalMinor: 2500,
      currency: 'EUR',
      createdAt: '2026-11-09T10:00:00.000Z',
      expiresAt: '2026-11-09T10:10:00.000Z',
      confirmedAt: null,
    };
    const held = message('booking', 'OrderStatisticsChanged.v1', orderId, 1, data);
    const confirmed = message('booking', 'OrderStatisticsChanged.v1', orderId, 2, {
      ...data,
      state: 'CONFIRMED',
      confirmedAt: '2026-11-09T10:01:00.000Z',
    });
    await handler.handle(confirmed);
    await handler.handle(held);
    await handler.handle(confirmed);
    const rows = await f.journal.rows('0');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].fact.sessionId, analyticsSessionId);
    await handler.handle({ ...held, producer: 'payments' });
    assert.equal((await f.journal.rows('0')).length, 2);
  } finally {
    await f.close();
  }
});
