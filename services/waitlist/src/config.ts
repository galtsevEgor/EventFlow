import { z } from 'zod';
import { mailConfig, workloadConfig } from '@eventflow/service-runtime';
export function readWaitlistConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      ...mailConfig,
      ...workloadConfig,
      WAITLIST_DATABASE_URL: z.url(),
      WAITLIST_CONTACT_KEY: z.string().regex(/^[a-f0-9]{64}$/),
      TEMPORAL_ADDRESS: z.string().min(1).default('127.0.0.1:17233'),
      TEMPORAL_NAMESPACE: z.string().min(1).default('eventflow'),
      MESSAGE_NAMESPACE: z
        .string()
        .regex(/^[a-z0-9-]{1,80}$/)
        .default('eventflow'),
      OIDC_ISSUER: z.url(),
      WAITLIST_CLIENT_SECRET: z.string().min(32),
      POLICY_CLIENT_SECRET: z.string().min(32),
      CATALOG_URL: z.url(),
      BOOKING_URL: z.url(),
      AMQP_URL: z.url(),
    })
    .parse(env);
}
export type WaitlistConfig = ReturnType<typeof readWaitlistConfig>;
