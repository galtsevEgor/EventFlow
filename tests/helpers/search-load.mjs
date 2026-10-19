import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { publishSearchEvent } from './search-catalog.mjs';

export async function seedSearchLoad(fixture, app, count) {
  const [{ name }] = await fixture.catalog.db.$queryRawUnsafe('SELECT current_database() AS name');
  assert.match(name, /^eventflow_test_[a-f0-9]{32}$/);
  const real = await publishSearchEvent(fixture.catalog, { title: 'Контрольная публикация' });
  await app.projection.sync();
  const template = await fixture.catalog.db.publication.findUniqueOrThrow({
    where: { eventId: real.eventId },
  });
  const index = await app.engine.activeIndex();
  let position = 1;
  for (let offset = 0; offset < count; offset += 500) {
    const documents = Array.from({ length: Math.min(500, count - offset) }, (_, k) => {
      const n = offset + k,
        date = new Date(Date.UTC(2035, 5, 1 + (n % 90), 16));
      return {
        id: randomUUID(),
        title: 'Концерт ' + ['альфа', 'бета', 'гамма'][n % 3] + ' ' + n,
        description: 'Синтетическое мероприятие: живая музыка, встречи и выступления.',
        city: ['Кишинёв', 'Бельцы', 'Оргеев'][n % 3],
        address: 'Тестовая сцена, 1',
        timeZone: 'Europe/Chisinau',
        startsAt: date.toISOString(),
        endsAt: new Date(date.getTime() + 7200000).toISOString(),
        localDate: date.toISOString().slice(0, 10),
        minPriceMinor: 1000 + (n % 40) * 100,
        currency: 'EUR',
        capacity: 100,
        coverId: null,
      };
    });
    await fixture.catalog.db.$transaction(async (tx) => {
      await tx.eventDraft.createMany({
        data: documents.map(({ id, title, description }) => ({
          id,
          title,
          description,
          organizationId: real.organizationId,
        })),
      });
      await tx.publication.createMany({
        data: documents.map(({ id }) => ({
          eventId: id,
          state: 'PUBLISHED',
          snapshot: template.snapshot,
          snapshotHash: template.snapshotHash,
        })),
      });
      await tx.publicEvent.createMany({
        data: documents.map((document) => ({
          eventId: document.id,
          city: document.city,
          address: document.address,
          timeZone: document.timeZone,
          startsAt: document.startsAt,
          endsAt: document.endsAt,
          localDate: document.localDate,
          minPriceMinor: document.minPriceMinor,
          currency: document.currency,
          capacity: document.capacity,
        })),
      });
      await tx.searchChange.createMany({
        data: documents.map((document) => ({ eventId: document.id, document })),
      });
    });
    const changes = await fixture.catalog.db.searchChange.findMany({
      where: { position: { gt: BigInt(position) } },
      orderBy: { position: 'asc' },
    });
    await app.store.apply(
      index,
      changes.map((change) => ({
        eventId: change.eventId,
        document: change.document,
        position: Number(change.position),
      })),
    );
    position = Number(changes.at(-1).position);
  }
  await app.engine.request('/' + index + '/_refresh', 'POST');
  await app.store.save(index, position, true);
  for (const table of ['PublicEvent', 'EventDraft', 'Publication'])
    await fixture.catalog.db.$executeRawUnsafe('ANALYZE "' + table + '"');
  return real;
}
