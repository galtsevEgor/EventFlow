import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { catalogFixture } from './fixture.mjs';
import { materializeSeats } from '../dist/events/configuration.js';

let fixture;
before(async () => {
  fixture = await catalogFixture();
});
after(async () => {
  await fixture?.close();
});

function configuration() {
  return {
    city: 'Кишинёв',
    address: 'Сад, улица Музыки, 12',
    timeZone: 'Europe/Chisinau',
    startsAt: '2030-06-01T16:00:00Z',
    endsAt: '2030-06-01T18:00:00Z',
    salesStartsAt: '2030-05-01T09:00:00Z',
    salesEndsAt: '2030-06-01T15:30:00Z',
    admissionStartsAt: '2030-06-01T15:00:00Z',
    admissionEndsAt: '2030-06-01T18:00:00Z',
    currency: 'EUR',
    categories: [
      { id: 'standard', name: 'Стандарт', priceMinor: 1500 },
      { id: 'front', name: 'Первый ряд', priceMinor: 2500 },
    ],
    layout: {
      rows: 20,
      columns: 50,
      defaultCategoryId: 'standard',
      overrides: [
        { row: 1, number: 1, categoryId: 'front', disabled: false },
        { row: 1, number: 2, categoryId: 'standard', disabled: true },
      ],
    },
  };
}
async function draft() {
  const actor = await fixture.token({ sub: randomUUID() });
  const org = await fixture.request('/api/v1/organizations', actor, 'POST', {
    name: 'Команда события',
  });
  const path = `/api/v1/organizations/${org.body.id}/events`;
  const event = await fixture.request(path, actor, 'POST', { title: 'Летний концерт' });
  assert.equal(event.status, 201);
  return { actor, path: `${path}/${event.body.id}`, org: org.body.id, id: event.body.id };
}
test('configuration persists exact UTC/IANA schedule, integer prices and 1000 unique grid positions', async () => {
  const event = await draft();
  const input = configuration();
  const saved = await fixture.request(event.path + '/configuration', event.actor, 'PUT', {
    revision: 0,
    configuration: input,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.deepEqual(saved.body.configuration, input);
  const seats = materializeSeats(input);
  assert.equal(seats.length, 999);
  assert.equal(new Set(seats.map((seat) => seat.seatId)).size, 999);
  assert.equal(seats[0].priceMinor, 2500);
  assert.equal(seats[1].seatId, 'r1-s3');
  assert.equal(seats.at(-1).seatId, 'r20-s50');
  const second = await fixture.request(event.path + '/configuration', event.actor, 'PUT', {
    revision: saved.body.revision,
    configuration: {
      ...input,
      layout: { ...input.layout, rows: 50, columns: 20, overrides: [] },
    },
  });
  assert.equal(second.status, 200);
  const fullGrid = materializeSeats(second.body.configuration);
  assert.equal(new Set(fullGrid.map((seat) => seat.seatId)).size, 1_000);
  assert.equal(fullGrid.at(-1).seatId, 'r50-s20');
  assert.equal(
    await fixture.db.auditEntry.count({
      where: { targetId: event.id, action: 'draft.configured' },
    }),
    2,
  );
});
test('invalid schedules, zones, prices and seat configurations leave the saved draft unchanged', async () => {
  const event = await draft();
  const changes = [
    (c) => {
      c.startsAt = '2030-06-01T16:00';
    },
    (c) => {
      c.timeZone = 'Mars/Olympus';
    },
    (c) => {
      c.endsAt = c.startsAt;
    },
    (c) => {
      c.salesEndsAt = c.endsAt;
    },
    (c) => {
      c.admissionStartsAt = c.endsAt;
    },
    (c) => {
      c.layout.rows = 21;
    },
    (c) => {
      c.layout.overrides.push(c.layout.overrides[0]);
    },
    (c) => {
      c.layout.overrides[0].number = 51;
    },
    (c) => {
      c.layout.defaultCategoryId = 'missing';
    },
    (c) => {
      c.categories[0].priceMinor = 15.5;
    },
    (c) => {
      c.categories[0].priceMinor = 10_000_001;
    },
    (c) => {
      c.categories[1].id = c.categories[0].id;
    },
    (c) => {
      c.layout = {
        rows: 1,
        columns: 1,
        defaultCategoryId: 'standard',
        overrides: [{ row: 1, number: 1, categoryId: 'standard', disabled: true }],
      };
    },
  ];
  for (const change of changes) {
    const input = configuration();
    change(input);
    const result = await fixture.request(event.path + '/configuration', event.actor, 'PUT', {
      revision: 0,
      configuration: input,
    });
    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.ok(result.body.fieldErrors);
  }
  const unchanged = await fixture.db.eventDraft.findUniqueOrThrow({ where: { id: event.id } });
  assert.equal(unchanged.revision, 0);
  assert.equal(unchanged.configuration, null);
});
test('concurrent configuration saves serialize and reject a stale editor instead of overwriting', async () => {
  const event = await draft();
  const results = await Promise.all(
    [1, 2].map(() =>
      fixture.request(event.path + '/configuration', event.actor, 'PUT', {
        revision: 0,
        configuration: configuration(),
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409).body.code, 'DRAFT_CHANGED');
  await fixture.request(event.path, event.actor, 'PATCH', { title: 'Новое название' });
  assert.equal(
    (
      await fixture.request(event.path + '/configuration', event.actor, 'PUT', {
        revision: 1,
        configuration: configuration(),
      })
    ).status,
    409,
  );
});
test('another tenant and staff cannot change configuration, and forged role headers confer no rights', async () => {
  const event = await draft();
  const outsider = await fixture.token({ sub: 'config-outsider' });
  const payload = { revision: 0, configuration: configuration() };
  assert.equal(
    (
      await fixture.request(event.path + '/configuration', outsider, 'PUT', payload, {
        'x-role': 'OWNER',
      })
    ).status,
    404,
  );
  await fixture.db.membership.create({
    data: {
      organizationId: event.org,
      userSubject: 'config-staff',
      email: 'staff@eventflow.test',
      role: 'STAFF',
    },
  });
  const staff = await fixture.token({ sub: 'config-staff' });
  assert.equal(
    (await fixture.request(event.path + '/configuration', staff, 'PUT', payload)).status,
    403,
  );
});
