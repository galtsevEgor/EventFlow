import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PNG } from 'pngjs';
import { catalogFixture } from './fixture.mjs';
import { publishSearchEvent } from '../../../tests/helpers/search-catalog.mjs';
import { eventually } from '../../../tests/helpers/eventually.mjs';
import { SearchFeed } from '../dist/search/feed.service.js';
import { captureSearchChange } from '../dist/search/snapshot.js';
import { lockOrganization } from '../dist/organizations/access.js';
import { CoverService } from '../dist/covers/cover.service.js';
import { DraftService } from '../dist/events/draft.service.js';

const searchRows = (db) =>
  db.outbox.findMany({
    where: { envelope: { path: ['eventType'], equals: 'SearchDocumentChanged.v1' } },
  });
const machine = (f) =>
  f.token({ azp: 'eventflow-search', realm_access: { roles: ['search-index'] } });

test('only confirmed publications enter a versioned public feed; description and cover changes share its transaction', async () => {
  const f = await catalogFixture();
  try {
    const pending = await publishSearchEvent(f, { confirm: false });
    assert.equal(await f.db.searchChange.count(), 0);
    const event = await publishSearchEvent(f);
    const first = await f.db.searchChange.findFirst();
    assert.equal(first.document.title, 'Джаз в саду');
    assert.equal(first.document.organizationId, undefined);
    assert.equal(first.document.email, undefined);
    assert.equal((await searchRows(f.db)).length, 1);
    const changed = await f.request(event.path, event.token, 'PATCH', {
      title: event.title,
      description: 'Новое публичное описание.',
    });
    assert.equal(changed.status, 200);
    const png = PNG.sync.write(new PNG({ width: 64, height: 64 }));
    const storage = { put: async () => {}, remove: async () => {} };
    await new CoverService(f.db, storage, new DraftService(f.db)).upload(
      event.actor,
      event.organizationId,
      event.eventId,
      { buffer: png, mimetype: 'image/png', size: png.length },
    );
    const rows = await f.db.searchChange.findMany({ orderBy: { position: 'asc' } });
    assert.equal(rows.length, 3);
    assert.equal(rows[1].document.description, 'Новое публичное описание.');
    assert.notEqual(rows[2].document.coverId, rows[1].document.coverId);
    assert.equal((await searchRows(f.db)).length, 3);
    await f.request(pending.path, pending.token, 'PATCH', {
      title: pending.title,
      description: 'Private draft secret',
    });
    assert.equal(await f.db.searchChange.count(), 3);
    await assert.rejects(
      f.db.$transaction(async (tx) => {
        await lockOrganization(tx, event.organizationId);
        await tx.eventDraft.update({
          where: { id: event.eventId },
          data: { description: 'must roll back' },
        });
        await captureSearchChange(tx, event.eventId);
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.equal(await f.db.searchChange.count(), 3);
    assert.equal((await searchRows(f.db)).length, 3);
    assert.equal(
      (await f.db.eventDraft.findUnique({ where: { id: event.eventId } })).description,
      'Новое публичное описание.',
    );
  } finally {
    await f.close();
  }
});

test('the feed requires a scoped machine JWT and reconciliation repairs old writes and persists tombstones', async () => {
  const f = await catalogFixture();
  try {
    const event = await publishSearchEvent(f),
      token = await machine(f);
    assert.equal((await f.request('/internal/search/changes')).status, 401);
    assert.equal((await f.request('/internal/search/changes', event.token)).status, 403);
    assert.equal(
      (await f.request('/internal/search/changes', await f.token({ azp: 'eventflow-search' })))
        .status,
      403,
    );
    const first = await f.request('/internal/search/changes?limit=1', token);
    assert.equal(first.status, 200);
    assert.equal(first.body.changes.length, 1);
    assert.equal(first.body.next, first.body.through);
    assert.equal(
      (await f.request('/internal/search/changes?after=2&through=1', token)).status,
      422,
    );
    await f.db.eventDraft.update({
      where: { id: event.eventId },
      data: { description: 'Written by an older application' },
    });
    assert.equal((await f.request('/internal/search/reconcile', token, 'POST', {})).status, 200);
    const repaired = await f.request('/internal/search/changes?after=' + first.body.next, token);
    assert.equal(repaired.body.changes[0].document.description, 'Written by an older application');
    await f.db.publicEvent.delete({ where: { eventId: event.eventId } });
    await f.request('/internal/search/reconcile', token, 'POST', {});
    const tombstone = await f.request(
      '/internal/search/changes?after=' + repaired.body.next,
      token,
    );
    assert.equal(tombstone.body.changes[0].document, null);
    const count = await f.db.searchChange.count();
    await f.request('/internal/search/reconcile', token, 'POST', {});
    assert.equal(await f.db.searchChange.count(), count);
  } finally {
    await f.close();
  }
});

test('the default change feed stops at 100 rows and its fixed watermark resumes at row 101', async () => {
  const f = await catalogFixture();
  try {
    const token = await machine(f);
    await f.db.searchChange.createMany({
      data: Array.from({ length: 101 }, () => ({ eventId: randomUUID() })),
    });
    const first = await f.request('/internal/search/changes', token);
    assert.equal(first.status, 200);
    assert.equal(first.body.changes.length, 100);
    assert.equal(first.body.next, first.body.changes.at(-1).position);
    assert.ok(first.body.next < first.body.through);
    const last = await f.request(
      `/internal/search/changes?after=${first.body.next}&through=${first.body.through}`,
      token,
    );
    assert.equal(last.status, 200);
    assert.equal(last.body.changes.length, 1);
    assert.equal(last.body.changes[0].position, first.body.through);
    assert.equal(last.body.next, first.body.through);
    assert.equal((await f.request('/internal/search/changes?limit=101', token)).status, 422);
    assert.equal(
      (await f.request('/internal/search/reconcile', token, 'POST', { limit: 101 })).status,
      422,
    );
  } finally {
    await f.close();
  }
});

test('a feed watermark never skips a transaction that allocated an earlier position but has not committed', async () => {
  const f = await catalogFixture();
  let release;
  try {
    const a = await publishSearchEvent(f),
      b = await publishSearchEvent(f),
      feed = new SearchFeed(f.db);
    const baseline = await feed.read({ after: 0, limit: 100 });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let captured;
    const ready = new Promise((resolve) => {
      captured = resolve;
    });
    const first = f.db.$transaction(
      async (tx) => {
        await lockOrganization(tx, a.organizationId);
        await tx.eventDraft.update({ where: { id: a.eventId }, data: { description: 'first' } });
        await captureSearchChange(tx, a.eventId);
        captured();
        await gate;
      },
      { timeout: 15000 },
    );
    await ready;
    const second = f.db.$transaction(
      async (tx) => {
        await lockOrganization(tx, b.organizationId);
        await tx.eventDraft.update({ where: { id: b.eventId }, data: { description: 'second' } });
        await captureSearchChange(tx, b.eventId);
      },
      { timeout: 15000 },
    );
    await eventually(
      () =>
        f.db.$queryRawUnsafe(
          "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
        ),
      (rows) => rows[0].count > 0,
    );
    assert.equal(
      (await feed.read({ after: baseline.through, limit: 100 })).through,
      baseline.through,
    );
    release();
    await Promise.all([first, second]);
    const next = await feed.read({ after: baseline.through, limit: 100 });
    assert.deepEqual(
      next.changes.map((change) => change.document.description),
      ['first', 'second'],
    );
    assert.equal(next.next, next.through);
  } finally {
    release?.();
    await f.close();
  }
});

test('the upgrade migration backfills only current confirmed public documents', async () => {
  const f = await catalogFixture();
  try {
    const event = await publishSearchEvent(f);
    await publishSearchEvent(f, { confirm: false });
    const [{ name }] = await f.db.$queryRawUnsafe('SELECT current_database() AS name');
    assert.match(name, /^eventflow_test_[a-f0-9]{32}$/);
    const sql = readFileSync(
      'services/catalog/prisma/migrations/202611090001_search_changes/migration.sql',
      'utf8',
    );
    await f.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('DROP TABLE "SearchChange"');
      for (const statement of sql.split(';').filter((value) => value.trim()))
        await tx.$executeRawUnsafe(statement);
    });
    const rows = await f.db.searchChange.findMany();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].document.id, event.eventId);
    assert.equal(rows[0].document.startsAt, '2035-06-01T16:00:00.000Z');
  } finally {
    await f.close();
  }
});
