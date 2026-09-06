import { z } from 'zod';

export function readCatalogConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      CATALOG_DATABASE_URL: z.url().startsWith('postgresql:'),
      OIDC_ISSUER: z.url(),
      MAXIMUM_PRICE_MINOR: z.coerce.number().int().positive().max(100_000_000).default(10_000_000),
    })
    .parse(env);
}
export type CatalogConfig = ReturnType<typeof readCatalogConfig>;
