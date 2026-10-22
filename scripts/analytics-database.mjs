import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export async function migrateAnalytics(env = process.env, { provision = true } = {}) {
  const url = new URL(env.ANALYTICS_DATABASE_URL);
  if (provision) {
    if (url.pathname !== '/analytics' || url.username !== 'analytics')
      throw new Error('Provisioning is restricted to the analytics database and role');
    const adminUrl = new URL(url);
    adminUrl.username = 'eventflow_admin';
    adminUrl.password = env.POSTGRES_ADMIN_PASSWORD;
    adminUrl.pathname = '/eventflow_admin';
    const admin = new pg.Client({ connectionString: adminUrl.href });
    await admin.connect();
    try {
      await admin.query('SELECT pg_advisory_lock(180001)');
      if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='analytics'")).rowCount)
        await admin.query(
          'CREATE ROLE analytics LOGIN PASSWORD ' +
            pg.escapeLiteral(decodeURIComponent(url.password)),
        );
      if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='analytics'")).rowCount)
        await admin.query('CREATE DATABASE analytics OWNER analytics');
      await admin.query('REVOKE CONNECT ON DATABASE analytics FROM PUBLIC');
    } finally {
      await admin.end();
    }
  }
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(180002)');
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query(
      'CREATE TABLE IF NOT EXISTS analytics_migration (id text PRIMARY KEY, hash char(64) NOT NULL)',
    );
    const sql = readFileSync(
      new URL('../services/analytics/migrations/001-journal.sql', import.meta.url),
      'utf8',
    );
    const hash = createHash('sha256').update(sql).digest('hex');
    const previous = (
      await client.query("SELECT hash FROM analytics_migration WHERE id='001-journal'")
    ).rows[0];
    if (previous && previous.hash !== hash)
      throw new Error('Analytics migration checksum mismatch');
    if (!previous) {
      await client.query(sql);
      await client.query('INSERT INTO analytics_migration VALUES ($1,$2)', ['001-journal', hash]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
