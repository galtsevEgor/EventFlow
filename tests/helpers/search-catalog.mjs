import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { message } from '../../packages/event-contracts/dist/index.js';
import { PublicationConsumer } from '../../services/catalog/dist/publication/consumer.js';

export const searchConfiguration = {
  city: 'Кишинёв',
  address: 'Улица Музыки, 12',
  timeZone: 'Europe/Chisinau',
  startsAt: '2035-06-01T16:00:00Z',
  endsAt: '2035-06-01T18:00:00Z',
  salesStartsAt: '2020-01-01T00:00:00Z',
  salesEndsAt: '2035-06-01T15:30:00Z',
  admissionStartsAt: '2035-06-01T15:00:00Z',
  admissionEndsAt: '2035-06-01T18:00:00Z',
  currency: 'EUR',
  categories: [{ id: 'standard', name: 'Стандарт', priceMinor: 2500 }],
  layout: { rows: 2, columns: 3, defaultCategoryId: 'standard', overrides: [] },
};
export async function publishSearchEvent(catalog, options = {}) {
  const token = await catalog.token();
  const organization = await catalog.request('/api/v1/organizations', token, 'POST', {
    name: 'Search fixture',
  });
  assert.equal(organization.status, 201);
  const organizationId = organization.body.id;
  const draft = await catalog.request(
    '/api/v1/organizations/' + organizationId + '/events',
    token,
    'POST',
    {
      title: options.title ?? 'Джаз в саду',
      description: options.description ?? 'Живая музыка летним вечером.',
    },
  );
  assert.equal(draft.status, 201);
  const eventId = draft.body.id,
    path = '/api/v1/organizations/' + organizationId + '/events/' + eventId;
  const configured = await catalog.request(path + '/configuration', token, 'PUT', {
    revision: 0,
    configuration: { ...searchConfiguration, ...options.configuration },
  });
  assert.equal(configured.status, 200);
  const coverId = randomUUID();
  await catalog.db.coverAsset.create({
    data: {
      id: coverId,
      eventId,
      objectKey: 'fixture/' + coverId,
      width: 800,
      height: 500,
      bytes: 100,
    },
  });
  await catalog.db.eventDraft.update({ where: { id: eventId }, data: { coverId } });
  const publication = await catalog.request(path + '/publication', token, 'POST', { revision: 1 });
  assert.equal(publication.status, 201);
  if (options.confirm !== false) {
    const current = await catalog.db.publication.findUniqueOrThrow({ where: { eventId } });
    await new PublicationConsumer(catalog.db).handle(
      message('booking', 'SaleProvisioned.v1', eventId, current.version, {
        snapshotHash: current.snapshotHash,
      }),
    );
  }
  return {
    token,
    organizationId,
    eventId,
    path,
    title: draft.body.title,
    actor: {
      subject: 'test-owner',
      name: 'Owner',
      email: 'owner@eventflow.test',
      emailVerified: true,
    },
  };
}
