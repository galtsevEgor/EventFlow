import { z } from 'zod';
import { MAX_EVENT_DESCRIPTION_LENGTH, MAX_EVENT_TITLE_LENGTH } from './event-content.js';
import { eventCurrencySchema, MAX_SEAT_PRICE_MINOR } from './purchase.js';

export const MAX_SEARCH_PAGE = 200;
export const MAX_SEARCH_PAGE_SIZE = 48;
export const MAX_SEARCH_CITY_FACETS = 30;
export const MAX_SEARCH_SUGGESTIONS = 6;

export const MAX_SEARCH_FEED_BATCH_SIZE = 100;
export const MAX_SEARCH_RECONCILE_BATCH_SIZE = 100;

export const searchDocumentSchema = z.strictObject({
  id: z.uuid(),
  title: z.string().min(2).max(MAX_EVENT_TITLE_LENGTH),
  description: z.string().max(MAX_EVENT_DESCRIPTION_LENGTH),
  city: z.string().min(1).max(100),
  address: z.string().min(1).max(300),
  timeZone: z.string().min(1).max(100),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  localDate: z.iso.date(),
  minPriceMinor: z.number().int().min(0).max(MAX_SEAT_PRICE_MINOR),
  currency: eventCurrencySchema,
  capacity: z.number().int().min(1).max(1_000_000),
  coverId: z.uuid().nullable(),
});
export type SearchDocument = z.infer<typeof searchDocumentSchema>;
export const searchChangeSchema = z
  .strictObject({
    position: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    eventId: z.uuid(),
    document: searchDocumentSchema.nullable(),
  })
  .refine((value) => !value.document || value.document.id === value.eventId);
export type SearchChange = z.infer<typeof searchChangeSchema>;
export const searchQuerySchema = z
  .strictObject({
    q: z.string().trim().max(160).default(''),
    city: z.string().trim().max(100).default(''),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    minPriceMinor: z.coerce.number().int().min(0).max(MAX_SEAT_PRICE_MINOR).optional(),
    maxPriceMinor: z.coerce.number().int().min(0).max(MAX_SEAT_PRICE_MINOR).optional(),
    sort: z.enum(['relevance', 'date', 'price_asc', 'price_desc']).default('date'),
    page: z.coerce.number().int().min(1).max(MAX_SEARCH_PAGE).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_SEARCH_PAGE_SIZE).default(12),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    path: ['to'],
    message: 'Проверьте диапазон дат.',
  })
  .refine(
    (value) =>
      value.minPriceMinor === undefined ||
      value.maxPriceMinor === undefined ||
      value.minPriceMinor <= value.maxPriceMinor,
    { path: ['maxPriceMinor'], message: 'Проверьте диапазон цены.' },
  );
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export const searchPageSchema = z.strictObject({
  searchProof: z.string().max(20000).optional(),
  events: z.array(searchDocumentSchema).max(MAX_SEARCH_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1).max(MAX_SEARCH_PAGE),
  pageSize: z.number().int().min(1).max(MAX_SEARCH_PAGE_SIZE),
  pages: z.number().int().min(0).max(MAX_SEARCH_PAGE),
  facets: z.strictObject({
    cities: z
      .array(z.strictObject({ value: z.string().max(100), count: z.number().int().nonnegative() }))
      .max(MAX_SEARCH_CITY_FACETS),
    price: z.strictObject({
      min: z.number().int().nonnegative().nullable(),
      max: z.number().int().nonnegative().nullable(),
    }),
  }),
  source: z.enum(['search', 'catalog']),
  limited: z.boolean(),
});
export type SearchPage = z.infer<typeof searchPageSchema>;
export const searchSuggestionsSchema = z.strictObject({
  suggestions: z
    .array(
      z.strictObject({
        id: z.uuid(),
        title: z.string().max(MAX_EVENT_TITLE_LENGTH),
        city: z.string().max(100),
      }),
    )
    .max(MAX_SEARCH_SUGGESTIONS),
  limited: z.boolean(),
});

export const searchFeedQuerySchema = z
  .strictObject({
    after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    through: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_FEED_BATCH_SIZE)
      .default(MAX_SEARCH_FEED_BATCH_SIZE),
  })
  .refine((value) => value.through === undefined || value.after <= value.through, {
    path: ['through'],
  });
export const searchFeedSchema = z.strictObject({
  changes: z.array(searchChangeSchema).max(MAX_SEARCH_FEED_BATCH_SIZE),
  through: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  next: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
