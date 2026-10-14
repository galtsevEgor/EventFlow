import assert from 'node:assert/strict';
import test from 'node:test';
import { Y, MAX_DESCRIPTION_LENGTH } from '@eventflow/collaboration';
import { DraftDocumentService } from '../dist/collaboration/document.service.js';
import { catalogFixture } from './fixture.mjs';

async function setup(fixture) {
  const token = await fixture.token();
  const organization = await fixture.request('/api/v1/organizations', token, 'POST', {
    name: 'Shared drafts',
  });
  assert.equal(organization.status, 201);
  const organizationId = organization.body.id;
  const draft = await fixture.request(
    `/api/v1/organizations/${organizationId}/events`,
    token,
    'POST',
    { title: 'Совместный концерт', description: 'Концерт' },
  );
  assert.equal(draft.status, 201);
  return {
    token,
    organizationId,
    eventId: draft.body.id,
    path: `/internal/collaboration/${organizationId}/${draft.body.id}`,
  };
}

test('concurrent Yjs writers merge durably, replay once and cannot be overwritten by a stale REST form', async () => {
  const f = await catalogFixture();
  try {
    const { token, organizationId, eventId, path } = await setup(f);
    const snapshot = await f.request(path, token);
    assert.equal(snapshot.status, 200);
    const a = new Y.Doc(),
      b = new Y.Doc();
    Y.applyUpdate(a, Buffer.from(snapshot.body.state, 'base64'));
    Y.applyUpdate(b, Buffer.from(snapshot.body.state, 'base64'));
    a.getText('description').insert(0, 'Живой ');
    b.getText('description').insert(7, ' вечером');
    const updates = [a, b].map((doc) => ({
      epoch: snapshot.body.epoch,
      state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
    }));
    const replies = await Promise.all(updates.map((body) => f.request(path, token, 'POST', body)));
    assert.ok(replies.every((reply) => reply.status === 201));
    const saved = (await f.request(path, token)).body;
    assert.equal(saved.description, 'Живой Концерт вечером');
    assert.equal(saved.version, 3);
    assert.equal((await f.request(path, token, 'POST', updates[0])).body.version, 3);
    assert.equal(await f.db.draftDocument.count(), 1);
    const fresh = await new DraftDocumentService(f.db).run(
      { subject: 'test-owner', email: 'owner@eventflow.test', emailVerified: true },
      organizationId,
      eventId,
    );
    assert.equal(fresh.state, saved.state);
    assert.equal((await f.db.eventDraft.findUnique({ where: { id: eventId } })).revision, 2);
    const resource = `/api/v1/organizations/${organizationId}/events/${eventId}`;
    assert.equal(
      (
        await f.request(resource, token, 'PATCH', {
          title: 'Новое название',
          description: 'Концерт',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(resource, token, 'PATCH', {
          title: 'Новое название',
          description: saved.description,
        })
      ).status,
      200,
    );
    const normal = await f.request(resource, token);
    assert.equal(normal.body.document, undefined);
    assert.equal(normal.body.state, undefined);
    a.destroy();
    b.destroy();
  } finally {
    await f.close();
  }
});

test('document access follows current organization roles, assignments and the publication barrier', async () => {
  const f = await catalogFixture();
  try {
    const { token, organizationId, eventId, path } = await setup(f);
    assert.equal((await f.request(path)).status, 401);
    const staff = await f.token({ sub: 'staff', email: 'staff@eventflow.test' });
    assert.equal((await f.request(path, staff)).status, 404);
    await f.db.membership.create({
      data: { organizationId, userSubject: 'staff', email: 'staff@eventflow.test', role: 'STAFF' },
    });
    assert.equal((await f.request(path, staff)).status, 404);
    await f.db.staffAssignment.create({ data: { organizationId, eventId, userSubject: 'staff' } });
    const view = await f.request(path, staff);
    assert.equal(view.status, 200);
    assert.equal(view.body.canEdit, false);
    assert.equal(
      (await f.request(path, staff, 'POST', { epoch: view.body.epoch, state: view.body.state }))
        .status,
      403,
    );
    await f.db.membership.update({
      where: { organizationId_userSubject: { organizationId, userSubject: 'staff' } },
      data: { role: 'MANAGER' },
    });
    assert.equal((await f.request(path, staff)).body.canEdit, true);
    await f.db.membership.delete({
      where: { organizationId_userSubject: { organizationId, userSubject: 'staff' } },
    });
    assert.equal((await f.request(path, staff)).status, 404);
    await f.db.publication.create({
      data: { eventId, snapshot: {}, snapshotHash: '0'.repeat(64) },
    });
    assert.equal((await f.request(path, token)).status, 409);
    assert.equal(
      (await f.request(path, token, 'POST', { epoch: view.body.epoch, state: view.body.state }))
        .status,
      409,
    );
  } finally {
    await f.close();
  }
});

test('malformed, over-limit and foreign CRDT state rolls back without changing the canonical draft', async () => {
  const f = await catalogFixture();
  try {
    const { token, eventId, path } = await setup(f);
    const snapshot = (await f.request(path, token)).body;
    const foreign = new Y.Doc();
    foreign.getMap('prices').set('amount', 1);
    const long = new Y.Doc();
    long.getText('description').insert(0, 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1));
    for (const data of [
      { epoch: snapshot.epoch, state: '/w==' },
      {
        epoch: snapshot.epoch,
        state: Buffer.from(Y.encodeStateAsUpdate(foreign)).toString('base64'),
      },
      { epoch: snapshot.epoch, state: Buffer.from(Y.encodeStateAsUpdate(long)).toString('base64') },
      { epoch: snapshot.epoch, state: snapshot.state, actor: 'forged' },
    ])
      assert.equal((await f.request(path, token, 'POST', data)).status, 422);
    assert.deepEqual((await f.request(path, token)).body, snapshot);
    assert.equal(
      (await f.db.eventDraft.findUnique({ where: { id: eventId } })).description,
      'Концерт',
    );
    foreign.destroy();
    long.destroy();
  } finally {
    await f.close();
  }
});
