import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { migrateAnalytics } from '../../scripts/analytics-database.mjs';
import { ClickHouse } from '../../services/analytics/dist/clickhouse.js';
import { Journal } from '../../services/analytics/dist/journal.js';

export async function analyticsFixture() {
  const id = randomUUID().replaceAll('-', ''),
    database = 'eventflow_test_' + id;
  const adminUrl = new URL(process.env.CATALOG_DATABASE_URL);
  adminUrl.username = 'eventflow_admin';
  adminUrl.password = process.env.POSTGRES_ADMIN_PASSWORD;
  adminUrl.pathname = '/eventflow_admin';
  const admin = new pg.Client({ connectionString: adminUrl.href });
  await admin.connect();
  await admin.query('CREATE DATABASE ' + database + ' OWNER analytics');
  const url = new URL(process.env.ANALYTICS_DATABASE_URL);
  url.pathname = '/' + database;
  const env = { ...process.env, ANALYTICS_DATABASE_URL: url.href, ANALYTICS_DATABASE: database };
  try {
    await migrateAnalytics(env, { provision: false });
  } catch (error) {
    await admin.query('DROP DATABASE ' + database + ' WITH (FORCE)');
    await admin.end();
    throw error;
  }
  const engine = new ClickHouse(env),
    journal = new Journal(url.href);
  return {
    env,
    engine,
    journal,
    async close() {
      await journal.onModuleDestroy();
      if (!/^eventflow_test_[a-f0-9]{32}$/.test(database))
        throw new Error('Unsafe analytics cleanup');
      await engine.command('DROP DATABASE IF EXISTS ' + database + ' SYNC');
      await admin.query('DROP DATABASE ' + database + ' WITH (FORCE)');
      await admin.end();
    },
  };
}
export function fact(overrides = {}) {
  return {
    key: randomUUID(),
    kind: 'impression',
    organizationId: randomUUID(),
    eventId: randomUUID(),
    sessionId: randomUUID(),
    orderId: null,
    searchId: null,
    occurredAt: '2026-11-09T10:00:00.000Z',
    source: 'catalog',
    resultCount: 0,
    limited: false,
    ...overrides,
  };
}
