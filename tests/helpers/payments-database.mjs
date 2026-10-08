import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { Database } from '../../services/payments/dist/database.js';

export async function paymentsDatabase() {
  const name = `eventflow_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({
    host: '127.0.0.1',
    port: Number(new URL(process.env.PAYMENTS_DATABASE_URL).port || 5432),
    user: 'eventflow_admin',
    password: process.env.POSTGRES_ADMIN_PASSWORD,
    database: 'eventflow_admin',
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" OWNER payments`);
  const url = new URL(process.env.PAYMENTS_DATABASE_URL);
  url.pathname = `/${name}`;
  let db;
  try {
    execFileSync(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'deploy',
        '--config=services/payments/prisma.config.ts',
      ],
      {
        env: { ...process.env, PAYMENTS_DATABASE_URL: url.href },
        stdio: 'pipe',
        windowsHide: true,
      },
    );
    db = new Database(url.href);
    await db.$connect();
    return {
      db,
      url: url.href,
      async close() {
        await db.$disconnect();
        await admin.query(`DROP DATABASE "${name}"`);
        await admin.end();
      },
    };
  } catch (error) {
    await db?.$disconnect();
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    throw error;
  }
}
