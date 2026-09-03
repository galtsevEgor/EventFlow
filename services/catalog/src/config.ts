import { z } from 'zod';

export function readCatalogConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({ CATALOG_DATABASE_URL: z.url().startsWith('postgresql:'), OIDC_ISSUER: z.url() })
    .parse(env);
}
export type CatalogConfig = ReturnType<typeof readCatalogConfig>;
