import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { collaborationFixture } from '../helpers/collaboration.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { CollaborationBus } from '../../apps/bff/dist/collaboration/bus.js';

test(
  'missed Redis notifications resynchronize from SQL and a BFF restart preserves document state and replay semantics',
  { timeout: 90000 },
  async () => {
    const f = await collaborationFixture();
    try {
      const first = await f.start(),
        second = await f.start(),
        session = await f.session(first);
      const a = await f.connect(first, session),
        b = await f.connect(second, session);
      first.app.get(CollaborationBus).subscriber.destroy();
      b.doc.getText('description').insert(0, 'После сбоя ');
      const update = b.edit();
      b.send(update);
      await b.wait((frame) => frame.type === 'ack' && frame.id === update.id);
      await a.wait(
        (frame) => frame.type === 'snapshot' && frame.snapshot.description === 'После сбоя Концерт',
      );
      await first.app.close();
      const restarted = await f.start(),
        recovered = await f.connect(restarted, session);
      assert.equal(recovered.initial.description, 'После сбоя Концерт');
      recovered.send(update);
      const replay = await recovered.wait(
        (frame) => frame.type === 'ack' && frame.id === update.id,
      );
      assert.equal(replay.snapshot.version, 2);
      assert.equal(
        await f.catalog.db.auditEntry.count({ where: { action: 'draft.description.updated' } }),
        1,
      );
      a.close();
      b.close();
      recovered.close();
    } finally {
      await f.close();
    }
  },
);

test(
  'publication closes existing editors and cannot race a late collaborative overwrite',
  { timeout: 90000 },
  async () => {
    const f = await collaborationFixture();
    try {
      const replica = await f.start(),
        session = await f.session(replica);
      const client = await f.connect(replica, session);
      await f.catalog.db.publication.create({
        data: { eventId: f.eventId, snapshot: {}, snapshotHash: '0'.repeat(64) },
      });
      client.doc.getText('description').insert(0, 'Запоздалая правка ');
      client.send(client.edit());
      await client.wait((frame) => frame.type === 'error' && frame.code === 'DRAFT_CLOSED');
      await eventually(
        () => client.client.readyState,
        (state) => state === WebSocket.CLOSED,
      );
      assert.equal(
        (await f.catalog.db.eventDraft.findUnique({ where: { id: f.eventId } })).description,
        'Концерт',
      );
      assert.equal(
        await f.catalog.db.auditEntry.count({ where: { action: 'draft.description.updated' } }),
        0,
      );
      assert.equal(
        await f.denied(replica, { origin: f.bff.config.PUBLIC_ORIGIN, cookie: session.cookie }),
        409,
      );
      client.close();
    } finally {
      await f.close();
    }
  },
);

test(
  'binary, oversized and duplicate-client messages close only the offending socket without a durable effect',
  { timeout: 90000 },
  async () => {
    const f = await collaborationFixture();
    try {
      const replica = await f.start(),
        session = await f.session(replica);
      const good = await f.connect(replica, session);
      const duplicate = await f.connect(replica, session, { clientId: good.doc.clientID });
      await duplicate.wait((frame) => frame.type === 'error' && frame.code === 'ROOM_FULL');
      const binary = await f.connect(replica, session);
      binary.client.send(Buffer.from([0, 1]));
      await binary.wait((frame) => frame.type === 'error' && frame.code === 'INVALID_MESSAGE');
      const oversized = await f.connect(replica, session);
      oversized.client.send('x'.repeat(100 * 1024));
      await eventually(
        () => oversized.client.readyState,
        (state) => state === WebSocket.CLOSED,
      );
      assert.equal(good.client.readyState, WebSocket.OPEN);
      good.doc.getText('description').insert(7, ' работает');
      const edit = good.edit();
      good.send(edit);
      await good.wait((frame) => frame.type === 'ack' && frame.id === edit.id);
      assert.equal(
        await f.catalog.db.auditEntry.count({ where: { action: 'draft.description.updated' } }),
        1,
      );
      for (const client of [good, duplicate, binary, oversized]) client.close();
    } finally {
      await f.close();
    }
  },
);

test(
  'a socket that never joins releases its connection instead of remaining idle indefinitely',
  { timeout: 90000 },
  async () => {
    const f = await collaborationFixture();
    try {
      const replica = await f.start(),
        session = await f.session(replica);
      const client = new WebSocket(replica.origin.replace(/^http/, 'ws') + f.path, {
        origin: f.bff.config.PUBLIC_ORIGIN,
        headers: { cookie: session.cookie },
      });
      client.on('error', () => {});
      try {
        await new Promise((resolve, reject) => {
          client.once('open', resolve);
          client.once('error', reject);
        });
        await eventually(
          () => client.readyState,
          (state) => state === WebSocket.CLOSED,
          10000,
        );
      } finally {
        client.terminate();
      }
    } finally {
      await f.close();
    }
  },
);
