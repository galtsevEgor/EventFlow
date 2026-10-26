import { z } from 'zod';
import { mailConfig, workloadConfig } from '@eventflow/service-runtime';

export function readTicketsConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      ...workloadConfig,
      ...mailConfig,
      CATALOG_URL: z.url(),
      POLICY_CLIENT_SECRET: z.string().min(32),
      BOOKING_URL: z.url(),
      TICKET_DELIVERY_CLIENT_SECRET: z.string().min(32),
      TICKETS_DATABASE_URL: z.url().startsWith('postgresql:'),
      OIDC_ISSUER: z.url(),
      AMQP_URL: z.url().startsWith('amqp'),
      MESSAGE_NAMESPACE: z
        .string()
        .regex(/^[a-z0-9-]{1,80}$/)
        .default('eventflow'),
      TICKET_QR_KEYS: z.string(),
      OFFLINE_CHECK_IN_KEY: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .optional(),
    })
    .parse(env);
}

export type TicketsConfig = ReturnType<typeof readTicketsConfig>;
