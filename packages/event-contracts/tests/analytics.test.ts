import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { analyticsBatchSchema, analyticsPeriodSchema, orderStatisticsSchema } from '../src/index';
test('browser analytics excludes server order states, organization claims and personal fields', () => {
  const event = {
    id: randomUUID(),
    kind: 'event_view',
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    source: 'direct',
  };
  expect(analyticsBatchSchema.safeParse({ events: [event] }).success).toBe(true);
  for (const extra of [
    { kind: 'confirmed' },
    { organizationId: randomUUID() },
    { email: 'private@example.test' },
    { orderId: randomUUID() },
  ])
    expect(analyticsBatchSchema.safeParse({ events: [{ ...event, ...extra }] }).success).toBe(
      false,
    );
  expect(analyticsPeriodSchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(
    false,
  );
  expect(analyticsPeriodSchema.safeParse({ from: '2026-11-02', to: '2026-11-01' }).success).toBe(
    false,
  );
});
test('legacy booking snapshots preserve their payload shape and may add only a nullable analytics identifier', () => {
  const data = {
    orderId: randomUUID(),
    saleId: randomUUID(),
    organizationId: randomUUID(),
    state: 'HELD',
    seatCount: 1,
    totalMinor: 100,
    currency: 'EUR',
    createdAt: '2026-11-09T10:00:00Z',
    expiresAt: '2026-11-09T10:10:00Z',
    confirmedAt: null,
  };
  expect(orderStatisticsSchema.parse(data)).toEqual(data);
  const analyticsSessionId = randomUUID();
  expect(orderStatisticsSchema.parse({ ...data, analyticsSessionId }).analyticsSessionId).toBe(
    analyticsSessionId,
  );
  expect(
    orderStatisticsSchema.safeParse({ ...data, analyticsSessionId: 'email@example.test' }).success,
  ).toBe(false);
});
