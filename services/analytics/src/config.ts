import { z } from 'zod';
import { workloadConfig } from '@eventflow/service-runtime';
export function readAnalyticsConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      ...workloadConfig,
      ANALYTICS_DATABASE_URL: z.url(),
      CLICKHOUSE_URL: z.url().refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', 'clickhouse'].includes(url.hostname) &&
          !url.username &&
          !url.password &&
          url.pathname === '/' &&
          !url.search &&
          !url.hash
        );
      }),
      CLICKHOUSE_USER: z.string().min(1),
      CLICKHOUSE_PASSWORD: z.string().min(24),
      ANALYTICS_DATABASE: z.string().regex(/^eventflow_[a-z0-9_]{1,64}$/),
      OIDC_ISSUER: z.url(),
      CATALOG_URL: z.url(),
      POLICY_CLIENT_SECRET: z.string().min(32),
      ANALYTICS_CLIENT_SECRET: z.string().min(32),
      AMQP_URL: z.url(),
      MESSAGE_NAMESPACE: z
        .string()
        .regex(/^[a-z0-9-]{1,80}$/)
        .default('eventflow'),
    })
    .parse(env);
}
export type AnalyticsConfig = ReturnType<typeof readAnalyticsConfig>;
