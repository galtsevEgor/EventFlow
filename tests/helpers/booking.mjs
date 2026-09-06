import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { createApplication } from '../../packages/service-runtime/dist/index.js';
import { AppModule } from '../../services/booking/dist/app.module.js';
import { Database } from '../../services/booking/dist/database.js';

export async function bookingFixture(namespace) {
  const database = `eventflow_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({
    host: '127.0.0.1',
    port: 15432,
    user: 'eventflow_admin',
    password: process.env.POSTGRES_ADMIN_PASSWORD,
    database: 'eventflow_admin',
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}" OWNER booking`);
  const url = new URL(process.env.BOOKING_DATABASE_URL);
  url.pathname = `/${database}`;
  let app;
  try {
    execFileSync(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'deploy',
        '--config=services/booking/prisma.config.ts',
      ],
      { env: { ...process.env, BOOKING_DATABASE_URL: url.href }, stdio: 'pipe', windowsHide: true },
    );
    app = await createApplication(
      AppModule.configure({
        BOOKING_DATABASE_URL: url.href,
        AMQP_URL: process.env.AMQP_URL,
        MESSAGE_NAMESPACE: namespace,
      }),
    );
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    return {
      app,
      db: app.get(Database),
      origin: await app.getUrl(),
      async close() {
        await app.close();
        await admin.query(`DROP DATABASE "${database}"`);
        await admin.end();
      },
    };
  } catch (error) {
    await app?.close();
    await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
    throw error;
  }
}
