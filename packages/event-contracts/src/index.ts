import { z } from 'zod';

export const eventEnvelopeSchema = z.strictObject({
  eventId: z.uuid(),
  eventType: z.string().regex(/^[A-Z][A-Za-z]+\.v1$/),
  schemaVersion: z.literal(1),
  aggregateId: z.uuid(),
  aggregateVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  correlationId: z.uuid(),
  causationId: z.uuid().optional(),
  traceparent: z
    .string()
    .regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
    .optional(),
  producer: z.enum(['catalog', 'booking', 'payments', 'tickets', 'waitlist']),
  data: z.record(z.string(), z.json()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export * from './sales.js';
export * from './event-content.js';
export * from './purchase.js';
export * from './orders.js';
export * from './payments.js';
export * from './check-in.js';
export * from './statistics.js';
export * from './refunds.js';
export * from './realtime.js';
export * from './operations.js';
export * from './search.js';
export * from './analytics.js';
export * from './waitlist.js';
export * from './offline.js';
export * from './recommendations.js';
export * from './seat-map.js';
export * from './cover.js';
