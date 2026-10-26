import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { migrateWaitlist } from '../../scripts/waitlist-database.mjs';
import { Database } from '../../services/waitlist/dist/database.js';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../services/waitlist/package.json', import.meta.url));
const { Connection, Client, WorkflowNotFoundError } = require('@temporalio/client');
export async function waitlistDatabase(namespace) {
  const database = 'eventflow_test_' + randomUUID().replaceAll('-', '');
  const adminUrl = new URL(process.env.WAITLIST_DATABASE_URL);
  adminUrl.username = 'eventflow_admin';
  adminUrl.password = process.env.POSTGRES_ADMIN_PASSWORD;
  adminUrl.pathname = '/eventflow_admin';
  const admin = new pg.Client({ connectionString: adminUrl.href });
  await admin.connect();
  const url = new URL(process.env.WAITLIST_DATABASE_URL);
  url.pathname = '/' + database;
  let db;
  async function close() {
    if (namespace && db) {
      if (!/^eventflow-test-[a-f0-9-]{36}$/.test(namespace))
        throw new Error('Unsafe workflow cleanup');
      const connection = await Connection.connect({
        address: process.env.TEMPORAL_ADDRESS,
        connectTimeout: '3 seconds',
      });
      try {
        const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE });
        for (const row of await db.query('SELECT sale_id FROM workflow_dispatch')) {
          await connection
            .withDeadline(Date.now() + 5000, () =>
              client.workflow
                .getHandle('waitlist:' + namespace + ':' + row.sale_id)
                .terminate('Fixture cleanup'),
            )
            .catch((e) => {
              if (!(e instanceof WorkflowNotFoundError)) throw e;
            });
        }
      } finally {
        await connection.close();
      }
    }
    await db?.onModuleDestroy();
    if (!/^eventflow_test_[a-f0-9]{32}$/.test(database)) throw new Error('Unsafe waitlist cleanup');
    await admin.query('DROP DATABASE IF EXISTS ' + database + ' WITH (FORCE)');
    await admin.end();
  }
  try {
    await admin.query('CREATE DATABASE ' + database + ' OWNER waitlist');
    await migrateWaitlist(
      { ...process.env, WAITLIST_DATABASE_URL: url.href },
      { provision: false },
    );
    db = new Database(url.href);
    return { db, databaseUrl: url.href, close };
  } catch (e) {
    await close();
    throw e;
  }
}
