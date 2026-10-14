import assert from 'node:assert/strict';
import test from 'node:test';
import { collaborationFixture } from '../helpers/collaboration.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { createGateway } from '../../scripts/gateway.mjs';

test(
  'two BFF sockets converge through durable Catalog state and replay an acknowledged operation without another effect',
  { timeout: 90000 },
  async () => {
    const f = await collaborationFixture();
    try {
      const first = await f.start(),
        second = await f.start();
      const session = await f.session(first);
      const a = await f.connect(first, session),
        b = await f.connect(second, session);
      a.doc.getText('description').insert(0, 'Живой ');
      b.doc.getText('description').insert(7, ' вечером');
      const edit = a.edit(),
        other = b.edit();
      a.send(edit);
      b.send(other);
      await a.wait((frame) => frame.type === 'ack' && frame.id === edit.id);
      await b.wait((frame) => frame.type === 'ack' && frame.id === other.id);
      const final = await a.wait(
        (frame) =>
          (frame.type === 'snapshot' || frame.type === 'ack') &&
          frame.snapshot.description === 'Живой Концерт вечером',
      );
      assert.equal(final.snapshot.version, 3);
      a.close();
      const reconnected = await f.connect(second, session);
      reconnected.send(edit);
      const replay = await reconnected.wait(
        (frame) => frame.type === 'ack' && frame.id === edit.id,
      );
      assert.equal(replay.snapshot.version, 3);
      assert.equal(
        await f.catalog.db.auditEntry.count({ where: { action: 'draft.description.updated' } }),
        2,
      );
      assert.equal(JSON.stringify(reconnected.frames).includes(session.token), false);
      b.close();
      reconnected.close();
    } finally {
      await f.close();
    }
  },
);

test(
  'upgrades require the exact origin and session; current roles and strict messages protect the draft',
  { timeout: 90000 },
  async () => {
    const f = await collaborationFixture();
    try {
      const replica = await f.start(),
        session = await f.session(replica);
      const origin = f.bff.config.PUBLIC_ORIGIN;
      assert.equal(await f.denied(replica, { origin }), 401);
      assert.equal(await f.denied(replica, { cookie: session.cookie }), 403);
      assert.equal(
        await f.denied(replica, { cookie: session.cookie, origin: 'http://attacker.test' }),
        403,
      );
      assert.equal(
        await f.denied(replica, { cookie: session.cookie, origin }, f.path + '?token=forged'),
        404,
      );
      await f.member('staff', 'STAFF', true);
      const staffSession = await f.session(replica, 'staff'),
        staff = await f.connect(replica, staffSession);
      assert.equal(staff.initial.canEdit, false);
      staff.send(staff.edit());
      await staff.wait((frame) => frame.type === 'error');
      assert.equal(await f.catalog.db.draftDocument.count(), 1);
      const forged = await f.connect(replica, session);
      forged.send({ ...forged.edit(), actor: 'forged-person' });
      await forged.wait((frame) => frame.type === 'error');
      assert.equal(
        (await f.catalog.db.eventDraft.findUnique({ where: { id: f.eventId } })).description,
        'Концерт',
      );
      const live = await f.connect(replica, session);
      await replica.store.destroy(session.id);
      await eventually(
        () => live.client.readyState,
        (state) => state === 3,
      );
      staff.close();
      forged.close();
      live.close();
    } finally {
      await f.close();
    }
  },
);

test(
  'the shared gateway forwards only the editor API upgrade and rejects internal or arbitrary API sockets',
  { timeout: 90000 },
  async () => {
    const f = await collaborationFixture();
    let gateway;
    try {
      const replica = await f.start(),
        session = await f.session(replica);
      gateway = createGateway({ bff: replica.origin });
      await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
      const origin = 'http://127.0.0.1:' + gateway.address().port;
      const viaGateway = { ...replica, origin };
      assert.equal(
        await f.denied(
          viaGateway,
          { origin: f.bff.config.PUBLIC_ORIGIN, cookie: session.cookie },
          '/internal/anything',
        ),
        404,
      );
      assert.equal(
        await f.denied(
          viaGateway,
          { origin: f.bff.config.PUBLIC_ORIGIN, cookie: session.cookie },
          '/api/v1/organizations',
        ),
        404,
      );
      const client = await f.connect(replica, session, { origin });
      assert.equal(client.initial.description, 'Концерт');
      client.close();
    } finally {
      await f.close();
      if (gateway) {
        gateway.closeAllConnections();
        await new Promise((resolve) => gateway.close(resolve));
      }
    }
  },
);
