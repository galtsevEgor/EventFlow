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
      PAYMENT_PROVIDER: z.enum(['fake', 'stripe']).default('fake'),
      STRIPE_SECRET_KEY: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z
          .string()
          .regex(/^sk_test_[A-Za-z0-9]+$/)
          .optional(),
      ),
      STRIPE_PUBLISHABLE_KEY: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z
          .string()
          .regex(/^pk_test_[A-Za-z0-9]+$/)
          .optional(),
      ),
      STRIPE_WEBHOOK_SECRET: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z
          .string()
          .regex(/^whsec_[A-Za-z0-9]+$/)
          .optional(),
      ),
    })
    .refine(
      (value) =>
        value.PAYMENT_PROVIDER !== 'stripe' ||
        Boolean(
          value.STRIPE_SECRET_KEY && value.STRIPE_PUBLISHABLE_KEY && value.STRIPE_WEBHOOK_SECRET,
        ),
      'Stripe sandbox keys and webhook secret are required',
    )
    .parse(env);
}
export type PaymentsConfig = ReturnType<typeof readPaymentsConfig>;
