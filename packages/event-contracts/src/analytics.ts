import { z } from 'zod';

export const analyticsKinds = [
  'impression',
  'event_view',
  'search_click',
  'search',
  'held',
  'confirmed',
] as const;
export const analyticsFactSchema = z.strictObject({
  key: z.string().min(1).max(180),
  kind: z.enum(analyticsKinds),
  organizationId: z.uuid().nullable(),
  eventId: z.uuid().nullable(),
  sessionId: z.uuid().nullable(),
  orderId: z.uuid().nullable(),
  searchId: z.uuid().nullable(),
  occurredAt: z.iso.datetime(),
  source: z.enum(['catalog', 'search', 'direct', 'booking']),
  resultCount: z.number().int().min(0).max(1000000).default(0),
  limited: z.boolean().default(false),
});
export type AnalyticsFact = z.infer<typeof analyticsFactSchema>;
export const browserAnalyticsSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['impression', 'event_view', 'search_click']),
  eventId: z.uuid(),
  occurredAt: z.iso.datetime(),
  source: z.enum(['catalog', 'search', 'direct']),
  searchProof: z.string().max(20000).optional(),
});
export const analyticsBatchSchema = z.strictObject({
  events: z.array(browserAnalyticsSchema).min(1).max(30),
});
export const analyticsPeriodSchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    eventId: z.uuid().optional(),
    source: z.enum(['catalog', 'search', 'direct']).optional(),
  })
  .refine(
    ({ from, to }) =>
      Date.parse(to) >= Date.parse(from) && Date.parse(to) - Date.parse(from) < 31 * 86400000,
    { message: 'Выберите период до 31 дня.' },
  );
export type AnalyticsPeriod = z.infer<typeof analyticsPeriodSchema>;
