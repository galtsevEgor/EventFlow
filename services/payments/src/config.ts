import { z } from 'zod';

export function readPaymentsConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      OIDC_ISSUER: z.url(),
      PAYMENTS_DATABASE_URL: z.url().startsWith('postgresql:'),
      BOOKING_URL: z.url(),
      PAYMENTS_CLIENT_SECRET: z.string().min(32),
      AMQP_URL: z.url().startsWith('amqp'),
      MESSAGE_NAMESPACE: z
        .string()
        .regex(/^[a-z0-9-]{1,80}$/)
        .default('eventflow'),
      PAYMENT_PROVIDER: z.literal('fake').default('fake'),
    })
    .parse(env);
}
export type PaymentsConfig = ReturnType<typeof readPaymentsConfig>;
