import { z } from 'zod';
import { workloadConfig } from '@eventflow/service-runtime';
export function readBookingConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      ...workloadConfig,
      OIDC_ISSUER: z.url(),
      BOOKING_CONTACT_KEY: z.string().regex(/^[a-f0-9]{64}$/),
      BOOKING_DATABASE_URL: z.url().startsWith('postgresql:'),
      AMQP_URL: z.url().startsWith('amqp'),
      MESSAGE_NAMESPACE: z
        .string()
        .regex(/^[a-z0-9-]{1,80}$/)
        .default('eventflow'),
    })
    .parse(env);
}
export type BookingConfig = ReturnType<typeof readBookingConfig>;
