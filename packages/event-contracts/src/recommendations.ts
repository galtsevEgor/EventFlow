import { z } from 'zod';
import { searchDocumentSchema } from './search.js';

export const RECOMMENDATIONS_DEFAULT_PAGE_SIZE = 6;
export const MAX_RECOMMENDATIONS_PAGE_SIZE = 12;
export const MAX_RECOMMENDATION_FAVORITES = 100;
export const MAX_RECOMMENDATION_HYDRATION_IDS = 100;

export const recommendationPageSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          event: searchDocumentSchema,
          reason: z.enum(['SIMILAR', 'INTERESTS', 'FAVORITES', 'UPCOMING']),
        }),
      )
      .max(MAX_RECOMMENDATIONS_PAGE_SIZE),
    mode: z.enum(['similar', 'personal', 'upcoming']),
    degraded: z.boolean(),
  })
  .refine((page) =>
    page.items.every((item) =>
      page.mode === 'similar'
        ? item.reason === 'SIMILAR'
        : page.mode === 'upcoming'
          ? item.reason === 'UPCOMING'
          : ['INTERESTS', 'FAVORITES'].includes(item.reason),
    ),
  );
export type RecommendationPage = z.infer<typeof recommendationPageSchema>;

export const recommendationProfileSchema = z.strictObject({
  revision: z.number().int().min(0).max(2147483647),
  interests: z.array(z.string().min(1).max(40)).max(8),
  favorites: z
    .array(z.strictObject({ eventId: z.uuid(), event: searchDocumentSchema.nullable() }))
    .max(MAX_RECOMMENDATION_FAVORITES),
});
export type RecommendationProfile = z.infer<typeof recommendationProfileSchema>;
export const recommendationInterestsSchema = z.strictObject({
  interests: z
    .array(z.strictObject({ id: z.string().min(1).max(40), title: z.string().min(1).max(100) }))
    .max(12),
});
