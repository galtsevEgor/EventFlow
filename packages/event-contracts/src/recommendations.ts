import { z } from 'zod';
import { searchDocumentSchema } from './search.js';
export const recommendationPageSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          event: searchDocumentSchema,
          reason: z.enum(['SIMILAR', 'INTERESTS', 'FAVORITES', 'UPCOMING']),
        }),
      )
      .max(12),
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
