import { randomUUID } from 'node:crypto';
import { currentTraceparent } from '@eventflow/telemetry';
import { z } from 'zod';
import { MAX_SEATS_PER_ROW, MAX_VENUE_ROWS, MAX_VENUE_SEATS, venueMapSchema } from './seat-map.js';
import { MAX_EVENT_TITLE_LENGTH } from './event-content.js';
import { eventCurrencySchema, MAX_SEAT_PRICE_MINOR } from './purchase.js';
import type { EventEnvelope } from './index.js';

export const provisionSchema = z
  .strictObject({
    organizationId: z.uuid(),
    title: z.string().min(2).max(MAX_EVENT_TITLE_LENGTH),
    currency: eventCurrencySchema,
    timeZone: z.string().max(100),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    salesStartsAt: z.iso.datetime(),
    salesEndsAt: z.iso.datetime(),
    admissionStartsAt: z.iso.datetime(),
    admissionEndsAt: z.iso.datetime(),
    seats: z
      .array(
        z.strictObject({
          seatId: z.string().regex(/^r\d+-s\d+$/),
          row: z.number().int().min(1).max(MAX_VENUE_ROWS),
          number: z.number().int().min(1).max(MAX_SEATS_PER_ROW),
          categoryId: z.string().max(32),
          categoryName: z.string().min(1).max(60),
          priceMinor: z.number().int().positive().max(MAX_SEAT_PRICE_MINOR),
        }),
      )
      .min(1)
      .max(MAX_VENUE_SEATS),
    seatMap: venueMapSchema.optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (!snapshot.seatMap) return;
    const ids = new Set(snapshot.seats.map((seat) => seat.seatId));
    if (
      ids.size !== snapshot.seatMap.seats.length ||
      snapshot.seatMap.seats.some((seat) => !ids.has(seat.seatId))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['seatMap', 'seats'],
        message: 'Map positions must match the sale inventory.',
      });
  });
export const provisionResultSchema = z.strictObject({
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export const provisionFailureSchema = provisionResultSchema.extend({
  code: z.enum(['SNAPSHOT_CONFLICT', 'INVALID_SNAPSHOT']),
});
export const availabilitySchema = z.strictObject({
  commandVersion: z.number().int().positive().max(2147483647),
  paused: z.boolean(),
});
export const saleRoutes = {
  booking: ['SaleProvisionRequested.v1', 'SaleAvailabilityRequested.v1'],
  catalog: ['SaleProvisioned.v1', 'SaleProvisionFailed.v1', 'SaleAvailabilityChanged.v1'],
};
export function message(
  producer: EventEnvelope['producer'],
  eventType: string,
  aggregateId: string,
  aggregateVersion: number,
  data: EventEnvelope['data'],
  cause?: EventEnvelope,
): EventEnvelope {
  const traceparent = currentTraceparent() ?? cause?.traceparent;
  return {
    eventId: randomUUID(),
    eventType,
    schemaVersion: 1,
    aggregateId,
    aggregateVersion,
    data,
    occurredAt: new Date().toISOString(),
    producer,
    correlationId: cause?.correlationId ?? randomUUID(),
    ...(cause ? { causationId: cause.eventId } : {}),
    ...(traceparent ? { traceparent } : {}),
  };
}
