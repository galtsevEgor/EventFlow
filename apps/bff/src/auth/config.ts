import { z } from 'zod';

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');
const httpUrl = z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol));
const schema = z.object({
  PUBLIC_ORIGIN: httpUrl,
  OIDC_ISSUER: httpUrl,
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(32),
  REDIS_URL: z.string().startsWith('redis'),
  SESSION_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9:_-]+$/)
    .default('eventflow:bff:'),
  CATALOG_URL: httpUrl,
  SEARCH_URL: httpUrl.default('http://127.0.0.1:4005'),
  SEARCH_ENABLED: z.enum(['true', 'false']).default('false'),
  ANALYTICS_ENABLED: z.enum(['true', 'false']).default('false'),
  ANALYTICS_URL: httpUrl.default('http://127.0.0.1:4006'),
  ANALYTICS_CLIENT_SECRET: z.string().min(32).optional(),
  ANALYTICS_SESSION_KEY: z.string().min(32).optional(),
  BOOKING_URL: httpUrl.default('http://127.0.0.1:4002'),
  PAYMENTS_URL: httpUrl.default('http://127.0.0.1:4003'),
  TICKETS_URL: httpUrl.default('http://127.0.0.1:4004'),
  WAITLIST_URL: httpUrl.default('http://127.0.0.1:4007'),
  WAITLIST_ENABLED: z.enum(['true', 'false']).default('false'),
  RECOMMENDATIONS_URL: httpUrl.default('http://127.0.0.1:4008'),
  RECOMMENDATIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  OBSERVABILITY_PUBLIC_ORIGIN: httpUrl
    .refine((value) => {
      const url = new URL(value);
      return (
        url.href === url.origin + '/' &&
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname))
      );
    })
    .default('http://127.0.0.1:13000'),
  AMQP_URL: z.string().startsWith('amqp').optional(),
  MESSAGE_NAMESPACE: z
    .string()
    .regex(/^[a-zA-Z0-9:_-]+$/)
    .default('eventflow'),
  REALTIME_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(10000).default(256),
  REALTIME_USER_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(4),
  REALTIME_IP_CONNECTIONS: z.coerce.number().int().min(1).max(10000).default(128),
  REALTIME_HEARTBEAT_MS: z.coerce.number().int().min(1000).max(10000).default(5000),
});
export type AuthConfig = ReturnType<typeof readAuthConfig>;
export function readAuthConfig(env: NodeJS.ProcessEnv) {
  const values = schema.parse(env);
  if (
    values.ANALYTICS_ENABLED === 'true' &&
    (!values.ANALYTICS_CLIENT_SECRET || !values.ANALYTICS_SESSION_KEY)
  )
    throw new Error('Enabled analytics requires its own service secret and session signing key');
  const origin = new URL(values.PUBLIC_ORIGIN);
  const issuer = new URL(values.OIDC_ISSUER);
  if (
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error('PUBLIC_ORIGIN must contain only an origin');
  }
  const local = (url: URL) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ([origin, issuer].some((url) => url.protocol !== 'https:' && !local(url)))
    throw new Error('HTTPS is required outside loopback development');
  if (env.NODE_ENV === 'production' && [origin, issuer].some((url) => url.protocol !== 'https:'))
    throw new Error('Production identity endpoints require HTTPS');
  return { ...values, PUBLIC_ORIGIN: origin.origin, secure: origin.protocol === 'https:' };
}

function unsafeCharacters(value: string) {
  return (
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

export function safeReturnTo(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^\/(?!\/)/.test(value) ||
    unsafeCharacters(value)
  )
    return '/organizer/';
  try {
    const decoded = decodeURIComponent(value);
    if (unsafeCharacters(decoded) || decoded.startsWith('//') || decoded.startsWith('/api/'))
      return '/organizer/';
    const url = new URL(value, 'https://eventflow.invalid');
    return url.origin === 'https://eventflow.invalid' && !url.pathname.startsWith('/api/')
      ? url.pathname + url.search
      : '/organizer/';
  } catch {
    return '/organizer/';
  }
}
