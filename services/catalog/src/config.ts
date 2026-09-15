import { z } from 'zod';
import { mailConfig } from '@eventflow/service-runtime';

export function readCatalogConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      ...mailConfig,
      CATALOG_INVITATION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
      CATALOG_DATABASE_URL: z.url().startsWith('postgresql:'),
      OIDC_ISSUER: z.url(),
      AMQP_URL: z.url().startsWith('amqp'),
      MESSAGE_NAMESPACE: z
        .string()
        .regex(/^[a-z0-9-]{1,80}$/)
        .default('eventflow'),
      MAXIMUM_PRICE_MINOR: z.coerce.number().int().positive().max(100_000_000).default(10_000_000),
      S3_ENDPOINT: z.url(),
      S3_ACCESS_KEY: z.string().min(1),
      S3_SECRET_KEY: z.string().min(1),
      S3_COVERS_BUCKET: z
        .string()
        .regex(/^eventflow-[a-z0-9-]{1,50}$/)
        .default('eventflow-covers'),
    })
    .parse(env);
}
export type CatalogConfig = ReturnType<typeof readCatalogConfig>;
