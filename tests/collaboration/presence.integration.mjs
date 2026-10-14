import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { collaborationFixture } from '../helpers/collaboration.mjs';
import { DocumentPresence } from '../../apps/bff/dist/collaboration/presence.js';
import { eventually } from '../helpers/eventually.mjs';

test(
  'presence binds identities to sessions, shares cursors across replicas and removes departed peers',
  { timeout: 90000 },
  async () => {
    const f = await collaborationFixture();
    try {
      const first = await f.start(),
        second = await f.start();
      await f.member('manager', 'MANAGER');
      const a = await f.connect(first, await f.session(first));
      const b = await f.connect(second, await f.session(second, 'manager'));
      const frame = await a.wait((frame) => frame.type === 'members' && frame.members.length === 2);
      assert.deepEqual(frame.members.map((peer) => peer.name).sort(), ['manager', 'test-owner']);
      assert.equal(JSON.stringify(frame).includes('@eventflow.test'), false);
      const cursor = {
        anchor: { tname: 'description', item: { client: 1, clock: 0 }, assoc: 0 },
        head: { tname: 'description', assoc: -1 },
      };
      b.send({ type: 'presence', cursor });
      const moved = await a.wait(
        (frame) =>
          frame.type === 'members' &&
          frame.members.some((peer) => peer.name === 'manager' && peer.cursor),
      );
      assert.deepEqual(moved.members.find((peer) => peer.name === 'manager').cursor, cursor);
      const before = a.frames.length;
      const heartbeat = await eventually(
        () =>
          a.frames
            .slice(before)
            .find((frame) => frame.type === 'members' && frame.members.length === 2),
        Boolean,
        15000,
      );
      assert.deepEqual(heartbeat.members.find((peer) => peer.name === 'manager').cursor, cursor);
      b.close();
      await a.wait((frame) => frame.type === 'members' && frame.members.length === 1);
      a.send({ type: 'presence', cursor: null, name: 'Forged owner', color: '#ffffff' });
      await a.wait((frame) => frame.type === 'error' && frame.code === 'INVALID_MESSAGE');
      a.close();
    } finally {
      await f.close();
    }
  },
);

test(
  'atomic presence leases enforce the global room limit, client uniqueness and expiry',
  { timeout: 90000 },
  async () => {
    const f = await collaborationFixture();
    try {
      const first = await f.start(),
        second = await f.start();
      const stores = [first.app.get(DocumentPresence), second.app.get(DocumentPresence)];
      const target = { organizationId: f.organizationId, eventId: f.eventId };
      const peers = Array.from({ length: 17 }, (_, clientId) => ({
        peerId: randomUUID(),
        clientId,
        name: 'Member',
        color: '#315eac',
        cursor: null,
      }));
      const attempts = await Promise.allSettled(
        peers.map((peer, i) => stores[i % 2].touch(target, peer)),
      );
      assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 16);
      const survivor = peers[attempts.findIndex((result) => result.status === 'fulfilled')];
      await assert.rejects(stores[1].touch(target, { ...survivor, peerId: randomUUID() }));
      await first.store.client.hSet(
        stores[0].key(target),
        survivor.peerId,
        JSON.stringify({ ...survivor, expiresAt: 0 }),
      );
      const replacement = { ...survivor, peerId: randomUUID() };
      const members = await stores[1].touch(target, replacement);
      assert.equal(members.length, 16);
      assert.equal(
        members.some((peer) => peer.peerId === survivor.peerId),
        false,
      );
      await stores[0].leave(target, replacement.peerId);
      assert.equal((await stores[0].touch(target, replacement)).length, 16);
    } finally {
      await f.close();
    }
  },
);
