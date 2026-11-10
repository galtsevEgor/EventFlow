import { z } from 'zod';

export const ANALYTICS_ATTRIBUTION_WINDOW_HOURS = 24;
export const ANALYTICS_UTC_DAY_MS = 86_400_000;
const ANALYTICS_MAX_REPORT_DAYS = 31;

export const analyticsKinds = [
  'impression',
  'event_view',
  'search_click',
  'search',
  'held',
  'confirmed',
  'waitlist_joined',
  'waitlist_offered',
  'waitlist_purchased',
  'waitlist_expired',
  'waitlist_cancelled',
  'waitlist_closed',
  'waitlist_skipped',
] as const;
export const analyticsFactSchema = z.strictObject({
  key: z.string().min(1).max(180),
  kind: z.enum(analyticsKinds),
  organizationId: z.uuid().nullable(),
  eventId: z.uuid().nullable(),
  sessionId: z.uuid().nullable(),
  orderId: z.uuid().nullable(),
  searchId: z.uuid().nullable(),
  waitlistEntryId: z.uuid().optional(),
  occurredAt: z.iso.datetime(),
  source: z.enum(['catalog', 'search', 'direct', 'booking', 'waitlist']),
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
export type BrowserAnalyticsEvent = z.infer<typeof browserAnalyticsSchema>;
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
      Date.parse(to) >= Date.parse(from) &&
      Date.parse(to) - Date.parse(from) < ANALYTICS_MAX_REPORT_DAYS * ANALYTICS_UTC_DAY_MS,
    { message: 'Выберите период до 31 дня.' },
  );
export type AnalyticsPeriod = z.infer<typeof analyticsPeriodSchema>;
const count = z.number().int().nonnegative();
export const analyticsStatusSchema = z.strictObject({
  sequence: z.string().regex(/^\d+$/),
  pending: count,
  updatedAt: z.iso.datetime(),
  stale: z.boolean(),
});
const totalsSchema = z.strictObject({
  impressions: count,
  views: count,
  held: count,
  confirmed: count,
  clicks: count,
  searchImpressions: count,
});
const periodResultSchema = totalsSchema.extend({
  conversion: z.number().min(0).max(1).nullable(),
  ctr: z.number().min(0).max(1).nullable(),
  groups: z.array(
    totalsSchema.extend({ date: z.iso.date(), eventId: z.uuid(), source: z.string() }),
  ),
});
export const analyticsReportSchema = z.strictObject({
  period: analyticsPeriodSchema,
  previousPeriod: analyticsPeriodSchema,
  current: periodResultSchema,
  previous: periodResultSchema,
  status: analyticsStatusSchema,
  generatedAt: z.iso.datetime(),
  timeZone: z.literal('UTC'),
  windowHours: z.literal(ANALYTICS_ATTRIBUTION_WINDOW_HOURS),
});
export type AnalyticsReportData = z.infer<typeof analyticsReportSchema>;
export const searchAnalyticsSchema = z.strictObject({
  searches: count,
  empty: count,
  limited: count,
  emptyRate: z.number().min(0).max(1).nullable(),
  status: analyticsStatusSchema,
  period: analyticsPeriodSchema,
});
