import { z } from 'zod';
import { MAX_SEAT_PRICE_MINOR } from '@eventflow/event-contracts';
import { mailConfig, messageNamespaceSchema, workloadConfig } from '@eventflow/service-runtime';

export const DEFAULT_CATALOG_MAXIMUM_PRICE_MINOR = 10_000_000;

export function readCatalogConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      ...workloadConfig,
      ...mailConfig,
      CATALOG_INVITATION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
      CATALOG_DATABASE_URL: z.url().startsWith('postgresql:'),
      OIDC_ISSUER: z.url(),
      AMQP_URL: z.url().startsWith('amqp'),
      MESSAGE_NAMESPACE: messageNamespaceSchema,
      MAXIMUM_PRICE_MINOR: z.coerce
        .number()
        .int()
        .positive()
        .max(MAX_SEAT_PRICE_MINOR)
        .default(DEFAULT_CATALOG_MAXIMUM_PRICE_MINOR),
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
