import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const secretKeys = [
  'POSTGRES_ADMIN_PASSWORD',
  ...['CATALOG', 'BOOKING', 'PAYMENTS', 'TICKETS', 'KEYCLOAK'].map((name) => `${name}_DB_PASSWORD`),
  'KEYCLOAK_ADMIN_PASSWORD',
  'REDIS_PASSWORD',
  'RABBITMQ_PASSWORD',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
];

export function initializeEnvironment(directory) {
  const path = resolve(directory, '.env');
  if (!existsSync(path)) {
    const values = Object.fromEntries(
      secretKeys.map((key) => [key, randomBytes(24).toString('hex')]),
    );
    for (const service of ['catalog', 'booking', 'payments', 'tickets']) {
      values[`${service.toUpperCase()}_DATABASE_URL`] =
        `postgresql://${service}:${values[`${service.toUpperCase()}_DB_PASSWORD`]}@127.0.0.1:15432/${service}`;
    }
    values.REDIS_URL = `redis://:${values.REDIS_PASSWORD}@127.0.0.1:16379`;
    values.AMQP_URL = `amqp://eventflow:${values.RABBITMQ_PASSWORD}@127.0.0.1:15673`;
    values.S3_ENDPOINT = 'http://127.0.0.1:18333';
    values.KEYCLOAK_URL = 'http://127.0.0.1:18080';
    values.MAILPIT_URL = 'http://127.0.0.1:18025';
    writeFileSync(
      path,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
  }
  const values = parseEnv(readFileSync(path, 'utf8'));
  for (const key of secretKeys) {
    if (!values[key] || values[key].startsWith('generated-by-')) {
      throw new Error(`Set ${key} in the existing .env; it has been preserved.`);
    }
  }
  const analyticsPassword = values.ANALYTICS_DB_PASSWORD || randomBytes(24).toString('hex');
  const analyticsUrl = new URL(values.CATALOG_DATABASE_URL);
  analyticsUrl.username = 'analytics';
  analyticsUrl.password = analyticsPassword;
  analyticsUrl.pathname = '/analytics';
  const additions = {
    WAITLIST_DB_PASSWORD: values.WAITLIST_DB_PASSWORD || randomBytes(24).toString('hex'),
    WAITLIST_URL: 'http://127.0.0.1:4007',
    WAITLIST_ENABLED: 'true',
    OFFLINE_CHECK_IN_KEY: randomBytes(32).toString('hex'),
    WAITLIST_CLIENT_SECRET: randomBytes(32).toString('hex'),
    WAITLIST_CONTACT_KEY: randomBytes(32).toString('hex'),
    TEMPORAL_ADDRESS: '127.0.0.1:17233',
    TEMPORAL_NAMESPACE: 'eventflow',
    ANALYTICS_DB_PASSWORD: analyticsPassword,
    ANALYTICS_DATABASE_URL: analyticsUrl.href,
    CLICKHOUSE_URL: 'http://127.0.0.1:18123',
    CLICKHOUSE_USER: 'analytics',
    CLICKHOUSE_PASSWORD: randomBytes(32).toString('hex'),
    ANALYTICS_DATABASE: 'eventflow_analytics',
    ANALYTICS_URL: 'http://127.0.0.1:4006',
    ANALYTICS_ENABLED: 'true',
    ANALYTICS_CLIENT_SECRET: randomBytes(32).toString('hex'),
    ANALYTICS_SESSION_KEY: randomBytes(32).toString('hex'),
    PUBLIC_ORIGIN: 'http://127.0.0.1:18000',
    OIDC_ISSUER: `${values.KEYCLOAK_URL}/realms/eventflow`,
    OIDC_CLIENT_ID: 'eventflow-bff',
    OIDC_CLIENT_SECRET: randomBytes(32).toString('hex'),
    POLICY_CLIENT_SECRET: randomBytes(32).toString('hex'),
    PAYMENTS_CLIENT_SECRET: randomBytes(32).toString('hex'),
    PAYMENTS_OPERATOR_SECRET: randomBytes(32).toString('hex'),
    CATALOG_URL: 'http://127.0.0.1:4001',
    BOOKING_URL: 'http://127.0.0.1:4002',
    PAYMENTS_URL: 'http://127.0.0.1:4003',
    TICKETS_URL: 'http://127.0.0.1:4004',
    SEARCH_URL: 'http://127.0.0.1:4005',
    SEARCH_ENABLED: 'true',
    SEARCH_CLIENT_SECRET: randomBytes(32).toString('hex'),
    OPENSEARCH_URL: 'http://127.0.0.1:19200',
    SEARCH_INDEX_NAMESPACE: 'eventflow-search',
    TICKET_QR_KEYS: `v1:${randomBytes(32).toString('hex')}`,
    BOOKING_CONTACT_KEY: randomBytes(32).toString('hex'),
    CATALOG_INVITATION_KEY: randomBytes(32).toString('hex'),
    TICKET_DELIVERY_CLIENT_SECRET: randomBytes(32).toString('hex'),
    MAIL_OPERATOR_SECRET: randomBytes(32).toString('hex'),
    MAILPIT_SMTP_PORT: '11025',
    PAYMENT_PROVIDER: 'fake',
  };
  for (const [key, value] of Object.entries(additions)) {
    if (!values[key]) {
      appendFileSync(path, `\n${key}=${value}\n`);
      values[key] = value;
    }
  }
  if (!values.WAITLIST_DATABASE_URL) {
    const url = new URL(values.CATALOG_DATABASE_URL);
    url.username = 'waitlist';
    url.password = values.WAITLIST_DB_PASSWORD;
    url.pathname = '/waitlist';
    appendFileSync(path, `\nWAITLIST_DATABASE_URL=${url.href}\n`);
  }
  mkdirSync(resolve(directory, 'work/local'), { recursive: true });
  writeFileSync(
    resolve(directory, 'work/local/s3.json'),
    JSON.stringify(
      {
        identities: [
          {
            name: 'eventflow-local',
            credentials: [
              {
                accessKey: values.S3_ACCESS_KEY,
                secretKey: values.S3_SECRET_KEY,
              },
            ],
            actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
          },
        ],
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initializeEnvironment(process.cwd());
  console.log('Local .env is ready; existing values were preserved. S3 credentials synchronized.');
}
