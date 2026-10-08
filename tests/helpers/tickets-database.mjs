import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Database } from '../../services/tickets/dist/database.js';

export async function ticketsDatabase() {
  const name = `eventflow_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({
    host: '127.0.0.1',
    port: Number(new URL(process.env.TICKETS_DATABASE_URL).port || 5432),
    user: 'eventflow_admin',
    password: process.env.POSTGRES_ADMIN_PASSWORD,
    database: 'eventflow_admin',
  });
  const url = new URL(process.env.TICKETS_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = new Database(url.href);
  await admin.connect();
  async function close() {
    try {
      await db.$disconnect();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } finally {
      await admin.end();
    }
  }
  try {
    await admin.query(`CREATE DATABASE "${name}" OWNER tickets`);
    execFileSync(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'deploy',
        '--config=services/tickets/prisma.config.ts',
      ],
      {
        env: { ...process.env, TICKETS_DATABASE_URL: url.href },
        stdio: 'pipe',
        windowsHide: true,
      },
    );
    await db.$connect();
    return { db, url: url.href, close };
  } catch (error) {
    await close();
    throw error;
  }
}
