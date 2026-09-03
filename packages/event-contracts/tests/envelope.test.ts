import { describe, expect, it } from 'vitest';
import { eventEnvelopeSchema } from '../src/index';

const event = {
  eventId: 'ad348a25-6932-410c-a4c8-74fcf15b5225',
  eventType: 'OrderConfirmed.v1',
  schemaVersion: 1,
  aggregateId: 'a7df5402-04be-4dbd-9981-eb2ef9e41941',
  aggregateVersion: 1,
  occurredAt: '2026-10-27T12:00:00Z',
  correlationId: '4ca573f5-3b2d-4c58-88f1-80dcff5296f6',
  producer: 'booking',
  data: {},
};

describe('event envelope', () => {
  it('accepts a versioned event with explicit producer and UTC time', () => {
    expect(eventEnvelopeSchema.parse(event)).toEqual(event);
  });
  it.each([
    { eventId: 'not-an-id' },
    { eventType: 'order-confirmed' },
    { eventType: 'OrderConfirmed.v2' },
    { schemaVersion: 2 },
    { aggregateVersion: 0 },
    { producer: 'browser' },
    { occurredAt: '2026-10-27 12:00' },
    { accessToken: 'unexpected' },
  ])('rejects malformed wire metadata: %j', (patch) => {
    expect(eventEnvelopeSchema.safeParse({ ...event, ...patch }).success).toBe(false);
  });
});
