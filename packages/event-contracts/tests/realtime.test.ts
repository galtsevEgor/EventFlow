import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { realtimeInvalidation, realtimeHintSchema, commerceRoutes } from '../src/index';

describe('realtime invalidation', () => {
  it('carries only an authorized scope and opaque identifiers', () => {
    const id = randomUUID();
    const event = realtimeInvalidation('tickets', { scope: 'order', id });
    expect(event.aggregateId).toBe(id);
    expect(event.data).toEqual({ scope: 'order', id });
    expect(
      realtimeHintSchema.safeParse({ ...event.data, buyerSubject: 'private', qr: 'secret' })
        .success,
    ).toBe(false);
    expect(() => realtimeInvalidation('payments', { scope: 'sale', id })).toThrow('scope');
    expect(realtimeHintSchema.safeParse({ scope: 'organizer-orders', id }).success).toBe(false);
  });
  it('isolates delivery from existing domain consumers', () => {
    expect(commerceRoutes.realtime).toContain('RealtimeInvalidated.v1');
    for (const [consumer, types] of Object.entries(commerceRoutes))
      if (consumer !== 'realtime') expect(types).not.toContain('RealtimeInvalidated.v1');
  });
});
