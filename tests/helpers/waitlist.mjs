import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { migrateWaitlist } from '../../scripts/waitlist-database.mjs';
import { Database } from '../../services/waitlist/dist/database.js';
import { Booking } from '../../services/waitlist/dist/booking.js';
import { WaitlistQueue } from '../../services/waitlist/dist/queue.js';
import { Coordinator } from '../../services/waitlist/dist/coordinator.js';
import { ClientCredentials, SecretBox } from '../../packages/service-runtime/dist/index.js';
import { testIdentity } from './identity.mjs';
import { bookingFixture } from './booking.mjs';
import { seedSale } from './sale.mjs';
import { cleanBroker } from './broker.mjs';
export async function waitlistFixture({ seats = 1 } = {}) {
  const namespace = 'eventflow-test-' + randomUUID(),
    database = 'eventflow_test_' + randomUUID().replaceAll('-', '');
  const identity = await testIdentity();
  let booking, db, admin;
  try {
    booking = await bookingFixture(namespace, 0, { OIDC_ISSUER: identity.issuer });
    const sale = await seedSale(booking.db, { seats });
    const adminUrl = new URL(process.env.WAITLIST_DATABASE_URL);
    adminUrl.username = 'eventflow_admin';
    adminUrl.password = process.env.POSTGRES_ADMIN_PASSWORD;
    adminUrl.pathname = '/eventflow_admin';
    admin = new pg.Client({ connectionString: adminUrl.href });
    await admin.connect();
    await admin.query('CREATE DATABASE ' + database + ' OWNER waitlist');
    const url = new URL(process.env.WAITLIST_DATABASE_URL);
    url.pathname = '/' + database;
    await migrateWaitlist(
      { ...process.env, WAITLIST_DATABASE_URL: url.href },
      { provision: false },
    );
    db = new Database(url.href);
    const api = new Booking(
      booking.origin,
      new ClientCredentials(identity.issuer, 'eventflow-waitlist', identity.serviceSecret),
    );
    const box = new SecretBox(process.env.WAITLIST_CONTACT_KEY);
    const queue = new WaitlistQueue(db, api, box),
      coordinator = new Coordinator(db, api, box);
    await queue.settings(sale.id, sale.organizationId, sale.title, true);
    return {
      namespace,
      databaseUrl: url.href,
      db,
      booking,
      api,
      queue,
      box,
      coordinator,
      identity,
      sale,
      join: (buyer = 'buyer') => queue.join(buyer, buyer + '@eventflow.test', sale.id, 'standard'),
      async close() {
        await db.onModuleDestroy();
        await booking.close();
        await identity.close();
        if (!/^eventflow_test_[a-f0-9]{32}$/.test(database))
          throw new Error('Unsafe waitlist cleanup');
        await admin.query('DROP DATABASE ' + database + ' WITH (FORCE)');
        await admin.end();
        await cleanBroker(namespace);
      },
    };
  } catch (e) {
    await db?.onModuleDestroy();
    await booking?.close();
    await identity.close();
    if (admin) {
      await admin.query('DROP DATABASE IF EXISTS ' + database + ' WITH (FORCE)');
      await admin.end();
    }
    await cleanBroker(namespace);
    throw e;
  }
}
