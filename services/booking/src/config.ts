import { z } from 'zod';
export function readBookingConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      OIDC_ISSUER: z.url(),
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
