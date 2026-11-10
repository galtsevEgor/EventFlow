import { z } from 'zod';
import { messageNamespaceSchema, workloadConfig } from '@eventflow/service-runtime';
export function readBookingConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      ...workloadConfig,
      OIDC_ISSUER: z.url(),
      CATALOG_URL: z.url(),
      POLICY_CLIENT_SECRET: z.string().min(32),
      BOOKING_CONTACT_KEY: z.string().regex(/^[a-f0-9]{64}$/),
      BOOKING_DATABASE_URL: z.url().startsWith('postgresql:'),
      AMQP_URL: z.url().startsWith('amqp'),
      MESSAGE_NAMESPACE: messageNamespaceSchema,
    })
    .parse(env);
}
export type BookingConfig = ReturnType<typeof readBookingConfig>;
