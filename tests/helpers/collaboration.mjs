import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { Y } from '../../packages/collaboration/dist/index.js';
import { catalogFixture } from '../../services/catalog/tests/fixture.mjs';
import { realtimeFixture } from './realtime.mjs';
import { eventually } from './eventually.mjs';

export async function collaborationFixture() {
  const catalog = await catalogFixture({ MAIL_DELIVERY_DISABLED: 'true' });
  let bff;
  const sockets = [];
  try {
    const token = await catalog.token();
    const organization = await catalog.request('/api/v1/organizations', token, 'POST', {
      name: 'Collaborating team',
    });
    assert.equal(organization.status, 201);
    const organizationId = organization.body.id;
    const draft = await catalog.request(
      '/api/v1/organizations/' + organizationId + '/events',
      token,
      'POST',
      { title: 'Shared concert', description: 'Концерт' },
    );
    assert.equal(draft.status, 201);
    const eventId = draft.body.id;
    bff = await realtimeFixture({ CATALOG_URL: catalog.origin });
    const path =
      '/api/v1/organizations/' + organizationId + '/events/' + eventId + '/collaboration/socket';
    return {
      catalog,
      bff,
      path,
      organizationId,
      eventId,
      start: () => bff.start(),
      async member(subject, role, assigned = false) {
        await catalog.db.membership.create({
          data: { organizationId, userSubject: subject, email: subject + '@eventflow.test', role },
        });
        if (assigned)
          await catalog.db.staffAssignment.create({
            data: { organizationId, eventId, userSubject: subject },
          });
      },
      async session(replica, sub = 'test-owner') {
        const accessToken = await catalog.token({ sub, email: sub + '@eventflow.test', name: sub });
        const id = await replica.store.create({
          user: { sub, email: sub + '@eventflow.test', emailVerified: true, name: sub },
          accessToken,
          refreshToken: 'synthetic-refresh',
          idToken: 'synthetic-id',
          csrf: 'x'.repeat(43),
          accessExpiresAt: Date.now() + 300000,
          absoluteExpiresAt: Date.now() + 3600000,
        });
        return { id, token: accessToken, cookie: 'eventflow_session=' + id };
      },
      async connect(replica, session, options = {}) {
        const doc = new Y.Doc();
        const client = new WebSocket(
          (options.origin ?? replica.origin).replace(/^http/, 'ws') + (options.path ?? path),
          {
            origin: bff.config.PUBLIC_ORIGIN,
            headers: { cookie: session.cookie, ...options.headers },
          },
        );
        const frames = [];
        client.on('error', () => {});
        client.on('message', (bytes) => frames.push(JSON.parse(bytes.toString())));
        sockets.push(client);
        await new Promise((resolve, reject) => {
          client.once('open', resolve);
          client.once('error', reject);
        });
        client.send(JSON.stringify({ type: 'join', clientId: options.clientId ?? doc.clientID }));
        const wait = (predicate) => eventually(() => frames.findLast(predicate), Boolean);
        const initial = await wait((frame) => frame.type === 'snapshot');
        Y.applyUpdate(doc, Buffer.from(initial.snapshot.state, 'base64'));
        return {
          client,
          frames,
          doc,
          initial: initial.snapshot,
          wait,
          send: (frame) => client.send(JSON.stringify(frame)),
          edit() {
            return {
              type: 'update',
              id: randomUUID(),
              epoch: initial.snapshot.epoch,
              state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
            };
          },
          close() {
            doc.destroy();
            client.terminate();
          },
        };
      },
      async denied(replica, headers, requestedPath = path) {
        const client = new WebSocket(replica.origin.replace(/^http/, 'ws') + requestedPath, {
          headers,
        });
        sockets.push(client);
        client.on('error', () => {});
        return new Promise((resolve, reject) => {
          client.once('unexpected-response', (_request, response) => {
            response.resume();
            client.terminate();
            resolve(response.statusCode);
          });
          client.once('open', () => reject(new Error('Unexpected upgrade')));
          client.once('error', reject);
        });
      },
      async close() {
        for (const socket of sockets) socket.terminate();
        await bff.close();
        await catalog.close();
      },
    };
  } catch (error) {
    await bff?.close();
    await catalog.close();
    throw error;
  }
}
