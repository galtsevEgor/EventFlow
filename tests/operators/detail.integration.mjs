import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { paymentsFixture } from '../helpers/payments.mjs';
import { pendingRefund } from '../helpers/payment-flow.mjs';
import { realtimeFixture } from '../helpers/realtime.mjs';
import { operatorSession } from '../helpers/operator.mjs';
import { jsonRequest } from '../helpers/identity.mjs';

test(
  'investigation combines an authoritative order and durable audit without exposing payment or QR credentials',
  { timeout: 120000 },
  async () => {
    const fixture = await paymentsFixture();
    let bff;
    try {
      const { refund, attempt, order, buyer } = await pendingRefund(fixture);
      await fixture.db.refundOperation.update({
        where: { id: refund.id },
        data: {
          state: 'REQUIRES_REVIEW',
          reviewCode: 'RETRY_LIMIT',
          traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
        },
      });
      await fixture.db.operatorAction.create({
        data: {
          key: randomUUID(),
          targetId: refund.id,
          kind: 'refund',
          actor: 'service-account',
          reason: 'Provider inspection scheduled',
        },
      });
      bff = await realtimeFixture({
        OIDC_ISSUER: fixture.identity.issuer,
        BOOKING_URL: fixture.booking.origin,
        PAYMENTS_URL: fixture.origin,
      });
      const replica = await bff.start(),
        operator = await operatorSession(replica, fixture.identity),
        path = `/api/v1/ops/issues/payments/refund/${refund.id}`;
      const response = await fetch(replica.origin + path, { headers: operator.headers }),
        body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.orderStatus, 'available');
      assert.equal(body.order.id, order.id);
      assert.equal(body.order.seatCount, 1);
      assert.equal(body.recoverable, true);
      assert.equal(body.actions.length, 1);
      assert.equal(body.actions[0].actor, 'service-account');
      assert.equal(body.actions[0].actorType, 'SERVICE');
      assert.match(body.version, /^[a-f0-9]{64}$/);
      assert.equal(new URL(body.traceUrl).searchParams.get('var-traceId'), 'a'.repeat(32));
      assert.ok(!JSON.stringify(body).includes(attempt.providerPaymentId));
      for (const key of [
        'buyerSubject',
        'providerPaymentId',
        'qrEncrypted',
        'traceparent',
        'clientSecret',
        'email',
      ])
        assert.ok(!JSON.stringify(body).includes(`"${key}"`));
      assert.equal(
        (await jsonRequest(fixture.booking.origin, `/internal/ops/orders/${order.id}`, buyer))
          .status,
        403,
      );
      const viewer = await operatorSession(replica, fixture.identity, {
        subject: 'viewer',
        roles: ['ops-view'],
      });
      assert.equal(
        (await (await fetch(replica.origin + path, { headers: viewer.headers })).json())
          .recoverable,
        false,
      );
      const oldVersion = body.version;
      await fixture.db.refundOperation.update({ where: { id: refund.id }, data: { failures: 1 } });
      assert.notEqual(
        (await (await fetch(replica.origin + path, { headers: operator.headers })).json()).version,
        oldVersion,
      );
      bff.config.BOOKING_URL = 'http://127.0.0.1:1';
      const unavailable = await (
        await fetch(replica.origin + path, { headers: operator.headers })
      ).json();
      assert.equal(unavailable.orderStatus, 'unavailable');
      assert.equal(unavailable.order, null);
      assert.equal(unavailable.actions.length, 1);
      const closed = await fetch(
        `${replica.origin}/api/v1/ops/issues/payments/payment/${attempt.id}`,
        { headers: operator.headers },
      );
      assert.equal(closed.status, 200);
      assert.equal((await closed.json()).issue.state, 'SUCCEEDED');
      await fixture.db.providerWebhook.create({
        data: {
          eventId: 'evt_rejected',
          objectId: 'private-provider-object',
          type: 'unknown',
          reviewCode: 'UNSUPPORTED_EVENT',
          processedAt: new Date(),
        },
      });
      const webhook = await (
        await fetch(replica.origin + '/api/v1/ops/issues/payments/webhook/evt_rejected', {
          headers: operator.headers,
        })
      ).json();
      assert.equal(webhook.issue.state, 'REQUIRES_REVIEW');
      assert.equal(webhook.recoverable, false);
    } finally {
      await bff?.close();
      await fixture.close();
    }
  },
);
