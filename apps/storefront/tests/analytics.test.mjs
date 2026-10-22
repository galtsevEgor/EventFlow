import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { analyticsBatch, restoreAnalyticsQueue } from '../app/analytics-queue.ts';
test('analytics retry batches fit browser keepalive budget and retain stable event IDs', () => {
  const events = Array.from({ length: 30 }, () => ({
    id: randomUUID(),
    kind: 'impression',
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    source: 'search',
    searchProof: 'a'.repeat(19000),
  }));
  const batch = analyticsBatch(events);
  assert.equal(batch.length, 2);
  assert.ok(new TextEncoder().encode(JSON.stringify({ events: batch })).length <= 48000);
  assert.deepEqual(
    batch.map((e) => e.id),
    events.slice(0, 2).map((e) => e.id),
  );
});
test('queue restore discards malformed and expired payloads without persisting unknown fields', () => {
  const now = Date.now(),
    event = {
      id: randomUUID(),
      kind: 'event_view',
      eventId: randomUUID(),
      occurredAt: new Date(now).toISOString(),
      source: 'direct',
    };
  assert.deepEqual(
    restoreAnalyticsQueue(
      [
        event,
        { ...event, email: 'never-store@example.test' },
        { ...event, occurredAt: '2026-01-01T00:00:00.000Z' },
        null,
      ],
      now,
    ),
    [event],
  );
});
