import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { paymentsFixture } from '../helpers/payments.mjs';
import { realtimeFixture } from '../helpers/realtime.mjs';
import { testIdentity, jsonRequest } from '../helpers/identity.mjs';

test(
  'operator payment pages use stable cursors across kinds, filters and exclude sensitive fields',
  { timeout: 120000 },
  async () => {
    const fixture = await paymentsFixture();
    try {
      const token = await fixture.identity.token('viewer', {
          aud: 'eventflow-payments',
          realm_access: { roles: ['ops-view'] },
        }),
        at = new Date(Date.now() - 60000);
      const ids = [];
      for (let i = 0; i < 5; i++) {
        const row = await fixture.db.paymentAttempt.create({
          data: {
            id: randomUUID(),
            orderId: randomUUID(),
            buyerSubject: 'private-buyer-email',
            provider: 'fake',
            providerPaymentId: `private-provider-${i}`,
            amountMinor: 2500,
            currency: 'EUR',
            expiresAt: new Date(Date.now() + 300000),
            createdAt: at,
            state: 'REQUIRES_REVIEW',
            reviewCode: 'RETRY_LIMIT',
          },
        });
        ids.push(row);
      }
      const refund = await fixture.db.refundOperation.create({
        data: {
          id: randomUUID(),
          attemptId: ids[0].id,
          orderId: ids[0].orderId,
          providerPaymentId: 'private-provider',
          amountMinor: 2500,
          currency: 'EUR',
          reason: 'LATE_PAYMENT',
          state: 'REQUIRES_REVIEW',
          reviewCode: 'RETRY_LIMIT',
          createdAt: at,
        },
      });
      await fixture.db.providerWebhook.create({
        data: {
          eventId: 'evt_review',
          objectId: 'private-webhook-object',
          type: 'payment_intent.succeeded',
          reviewCode: 'AMOUNT_MISMATCH',
          createdAt: at,
        },
      });
      for (const auth of [
        undefined,
        await fixture.identity.token('buyer', { aud: 'eventflow-payments' }),
      ])
        assert.ok(
          [401, 403].includes(
            (await jsonRequest(fixture.origin, '/internal/ops/issues', auth)).status,
          ),
        );
      const found = [];
      let cursor;
      do {
        const response = await jsonRequest(
          fixture.origin,
          `/internal/ops/issues?limit=2${cursor ? '&cursor=' + cursor : ''}`,
          token,
        );
        assert.equal(response.status, 200);
        assert.ok(response.body.items.length <= 2);
        assert.ok(!JSON.stringify(response.body).includes('private'));
        found.push(...response.body.items);
        cursor = response.body.nextCursor;
      } while (cursor);
      assert.equal(found.length, 7);
      assert.equal(new Set(found.map((row) => row.kind + row.id)).size, 7);
      assert.ok(found.some((row) => row.id === refund.id));
      const filtered = await jsonRequest(
        fixture.origin,
        `/internal/ops/issues?orderId=${ids[0].orderId}`,
        token,
      );
      assert.equal(filtered.body.items.length, 2);
      assert.equal(
        (await jsonRequest(fixture.origin, '/internal/ops/issues?kind=refund', token)).body.items
          .length,
        1,
      );
      for (const suffix of [
        'limit=51',
        'limit=0',
        'cursor=invalid',
        'kind=secret',
        'orderId=invalid',
      ])
        assert.equal(
          (await jsonRequest(fixture.origin, '/internal/ops/issues?' + suffix, token)).status,
          422,
        );
    } finally {
      await fixture.close();
    }
  },
);

test('BFF overview isolates unavailable or malformed sources and keeps bearer identity private', async () => {
  const identity = await testIdentity(),
    servers = [];
  let fixture;
  try {
    for (const [status, body] of [
      [200, { items: [], nextCursor: null }],
      [503, { secret: 'private-upstream' }],
      [200, { items: new Array(100).fill({}), nextCursor: null }],
    ]) {
      const server = createServer((request, response) => {
        assert.ok(request.headers.authorization?.startsWith('Bearer '));
        assert.equal(request.headers['x-operator-subject'], undefined);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
    }
    fixture = await realtimeFixture({
      OIDC_ISSUER: identity.issuer,
      PAYMENTS_URL: `http://127.0.0.1:${servers[0].address().port}`,
      CATALOG_URL: `http://127.0.0.1:${servers[1].address().port}`,
      TICKETS_URL: `http://127.0.0.1:${servers[2].address().port}`,
    });
    const replica = await fixture.start(),
      accessToken = await identity.token('viewer', {
        aud: 'eventflow-payments',
        realm_access: { roles: ['ops-view'] },
      });
    const id = await replica.store.create({
      user: { sub: 'viewer', email: 'viewer@eventflow.test', emailVerified: true, name: 'Viewer' },
      accessToken,
      refreshToken: 'synthetic',
      idToken: 'synthetic',
      csrf: 'x'.repeat(43),
      accessExpiresAt: Date.now() + 240000,
      absoluteExpiresAt: Date.now() + 3600000,
    });
    const headers = { cookie: `eventflow_session=${id}`, 'x-operator-subject': 'spoofed' };
    const response = await fetch(replica.origin + '/api/v1/ops/issues', { headers }),
      body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(
      body.sources.map((source) => source.available),
      [true, false, false],
    );
    assert.ok(!JSON.stringify(body).includes('private'));
    assert.ok(!JSON.stringify(body).includes(accessToken));
    assert.equal(
      (await fetch(replica.origin + '/api/v1/ops/issues/catalog', { headers })).status,
      503,
    );
    assert.equal(
      (await fetch(replica.origin + '/api/v1/ops/issues/payments?limit=51', { headers })).status,
      422,
    );
  } finally {
    await fixture?.close();
    await identity.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
