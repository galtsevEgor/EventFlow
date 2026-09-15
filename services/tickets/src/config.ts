import { z } from 'zod';

export function readTicketsConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      TICKETS_DATABASE_URL: z.url().startsWith('postgresql:'),
      OIDC_ISSUER: z.url(),
      AMQP_URL: z.url().startsWith('amqp'),
      MESSAGE_NAMESPACE: z
        .string()
        .regex(/^[a-z0-9-]{1,80}$/)
        .default('eventflow'),
      TICKET_QR_KEYS: z.string(),
    })
    .parse(env);
}

export type TicketsConfig = ReturnType<typeof readTicketsConfig>;
