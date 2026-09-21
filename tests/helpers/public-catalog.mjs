import { randomUUID } from 'node:crypto';
import pg from 'pg';

export async function publicCatalogFixture(stack) {
  if (!/^eventflow_e2e_[a-f0-9]{32}$/.test(stack.catalogDatabase))
    throw new Error('Synthetic catalog requires an owned E2E database');
  const url = new URL(process.env.CATALOG_DATABASE_URL);
  url.pathname = '/' + stack.catalogDatabase;
  const db = new pg.Client({ connectionString: url.href });
  await db.connect();
  try {
    const organizationId = randomUUID();
    await db.query('INSERT INTO "Organization" (id, name, "createdBy") VALUES ($1, $2, $3)', [
      organizationId,
      'HTTP capacity fixture',
      'synthetic',
    ]);
    for (let i = 0; i < 12; i++) {
      const id = randomUUID();
      await db.query('INSERT INTO "EventDraft" (id, "organizationId", title) VALUES ($1, $2, $3)', [
        id,
        organizationId,
        `EF-111 synthetic event ${String(i).padStart(2, '0')}`,
      ]);
      await db.query(
        `INSERT INTO "PublicEvent" ("eventId", city, address, "timeZone", "startsAt", "endsAt", "localDate", "minPriceMinor", currency, capacity)
        VALUES ($1, 'Кишинёв', 'Синтетическая сцена, 1', 'Europe/Chisinau', '2035-06-01T16:00:00Z', '2035-06-01T18:00:00Z', '2035-06-01', 2500, 'EUR', 1000)`,
        [id],
      );
    }
    return { db, close: () => db.end() };
  } catch (error) {
    await db.end();
    throw error;
  }
}
