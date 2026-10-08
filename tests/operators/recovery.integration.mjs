import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { paymentsFixture } from '../helpers/payments.mjs';
import { pendingRefund } from '../helpers/payment-flow.mjs';
import { realtimeFixture } from '../helpers/realtime.mjs';
import { operatorSession } from '../helpers/operator.mjs';
import { jsonRequest, testIdentity } from '../helpers/identity.mjs';
import { ticketsService } from '../helpers/tickets-service.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { ProcessRefund } from '../../services/payments/dist/refunds/process.js';

test(
  'human recovery is CSRF protected, audited once and reconciles the original refund after a lost provider reply',
  { timeout: 120000 },
  async () => {
    const fixture = await paymentsFixture();
    let bff;
    try {
      const { refund } = await pendingRefund(fixture),
        processor = fixture.app.get(ProcessRefund);
      fixture.provider.inject('refund', { loseResponse: true });
      await processor.run(refund.id);
      await fixture.db.refundOperation.update({
        where: { id: refund.id },
        data: { state: 'REQUIRES_REVIEW', reviewCode: 'RETRY_LIMIT' },
      });
      bff = await realtimeFixture({
        OIDC_ISSUER: fixture.identity.issuer,
        PAYMENTS_URL: fixture.origin,
        BOOKING_URL: fixture.booking.origin,
      });
      const replica = await bff.start(),
        operator = await operatorSession(replica, fixture.identity),
        viewer = await operatorSession(replica, fixture.identity, {
          subject: 'viewer',
          roles: ['ops-view'],
        }),
        other = await operatorSession(replica, fixture.identity, { subject: 'other-operator' });
      const path = `/api/v1/ops/issues/payments/refund/${refund.id}`,
        detail = await (await fetch(replica.origin + path, { headers: operator.headers })).json();
      const data = { reason: 'Provider restored after an outage', version: detail.version },
        key = randomUUID();
      const send = (body = data, headers = operator.headers, requestKey = key) =>
        fetch(replica.origin + path + '/recover', {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json',
            'idempotency-key': requestKey,
            'x-operator-subject': 'forged-person',
          },
          body: JSON.stringify(body),
        });
      assert.equal((await send(data, viewer.headers)).status, 403);
      assert.equal((await send(data, { cookie: operator.headers.cookie })).status, 403);
      for (const body of [
        { ...data, reason: 'short' },
        { ...data, actor: 'forged' },
        { ...data, amountMinor: 1 },
        { ...data, version: '0'.repeat(64) },
      ])
        assert.ok([409, 422].includes((await send(body)).status));
      assert.equal(await fixture.db.operatorAction.count(), 0);
      const responses = await Promise.all(Array.from({ length: 10 }, () => send()));
      assert.ok(responses.every((response) => response.status === 202));
      assert.equal(await fixture.db.operatorAction.count({ where: { key } }), 1);
      const audit = await fixture.db.operatorAction.findUnique({ where: { key } });
      assert.equal(audit.actor, 'human-operator');
      assert.equal(audit.actorType, 'HUMAN');
      assert.equal(audit.reason, data.reason);
      assert.equal(audit.expectedVersion, data.version);
      assert.equal((await send(data, other.headers, randomUUID())).status, 409);
      assert.equal((await send({ ...data, reason: 'Changed explanation' })).status, 409);
      assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
      await processor.run(refund.id);
      assert.equal(
        (await fixture.db.refundOperation.findUnique({ where: { id: refund.id } })).state,
        'SUCCEEDED',
      );
      assert.equal((await send()).status, 202);
      assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
      const completed = await (
        await fetch(replica.origin + path, { headers: operator.headers })
      ).json();
      assert.equal(completed.recoverable, false);
      assert.equal(completed.actions.length, 1);
      assert.equal(completed.actions[0].actorType, 'HUMAN');
    } finally {
      await bff?.close();
      await fixture.close();
    }
  },
);

test(
  'recovery cannot steal a live worker lease or override a booking binding review',
  { timeout: 120000 },
  async () => {
    const fixture = await paymentsFixture();
    try {
      const token = await fixture.identity.token('operator', {
          aud: 'eventflow-payments',
          realm_access: { roles: ['ops-view', 'ops-recover'] },
        }),
        id = randomUUID();
      await fixture.db.paymentAttempt.create({
        data: {
          id,
          orderId: randomUUID(),
          buyerSubject: 'buyer',
          amountMinor: 2500,
          currency: 'EUR',
          provider: 'fake',
          expiresAt: new Date(Date.now() + 300000),
          state: 'REQUIRES_REVIEW',
          reviewCode: 'RETRY_LIMIT',
          lease: randomUUID(),
          leaseUntil: new Date(Date.now() + 60000),
        },
      });
      const path = `/internal/ops/issues/payment/${id}`;
      let detail = (await jsonRequest(fixture.origin, path, token)).body;
      let result = await jsonRequest(
        fixture.origin,
        path + '/recover',
        token,
        'POST',
        { reason: 'Inspect after provider recovery', version: detail.version },
        randomUUID(),
      );
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'OPERATION_BUSY');
      await fixture.db.paymentAttempt.update({
        where: { id },
        data: { lease: null, leaseUntil: null, reviewCode: 'BOOKING_BINDING_REVIEW' },
      });
      detail = (await jsonRequest(fixture.origin, path, token)).body;
      result = await jsonRequest(
        fixture.origin,
        path + '/recover',
        token,
        'POST',
        { reason: 'Inspect after provider recovery', version: detail.version },
        randomUUID(),
      );
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'INVESTIGATION_REQUIRED');
      assert.equal(await fixture.db.operatorAction.count(), 0);
      assert.equal(await fixture.db.fakePayment.count(), 0);
    } finally {
      await fixture.close();
    }
  },
);

test(
  'concurrent mail recovery reuses one job and audit, and a later incident requires a fresh version',
  { timeout: 120000 },
  async () => {
    const identity = await testIdentity(),
      namespace = `eventflow-test-${randomUUID()}`;
    let fixture;
    try {
      fixture = await ticketsService(namespace, {
        OIDC_ISSUER: identity.issuer,
        MAIL_DELIVERY_DISABLED: 'true',
      });
      const token = await identity.token('mail-operator', {
          aud: 'eventflow-tickets',
          realm_access: { roles: ['ops-view', 'ops-recover'] },
        }),
        id = randomUUID(),
        at = new Date(Date.now() - 60000);
      await fixture.db.deliveryJob.create({
        data: { id, state: 'DEAD', attempts: 4, nextRunAt: at },
      });
      const path = `/internal/ops/issues/mail/${id}`,
        detail = (await jsonRequest(fixture.origin, path, token)).body,
        key = randomUUID(),
        data = { reason: 'Mail transport restored after outage', version: detail.version };
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          jsonRequest(fixture.origin, path + '/recover', token, 'POST', data, key),
        ),
      );
      assert.ok(responses.every((response) => response.status === 202));
      assert.equal(await fixture.db.deliveryRetry.count(), 1);
      assert.equal(await fixture.db.deliveryJob.count(), 1);
      const audit = await fixture.db.deliveryRetry.findUnique({ where: { requestId: key } });
      assert.equal(audit.actorSubject, 'mail-operator');
      assert.equal(audit.actorType, 'HUMAN');
      assert.equal(
        (
          await jsonRequest(
            fixture.origin,
            path + '/recover',
            token,
            'POST',
            { ...data, reason: 'Different request reason' },
            key,
          )
        ).status,
        409,
      );
      await fixture.db.deliveryJob.update({
        where: { id },
        data: { state: 'DEAD', attempts: 4, nextRunAt: at },
      });
      assert.equal(
        (await jsonRequest(fixture.origin, path + '/recover', token, 'POST', data, randomUUID()))
          .status,
        409,
      );
      assert.equal(
        (await jsonRequest(fixture.origin, path + '/recover', token, 'POST', data, key)).status,
        202,
      );
      assert.equal((await fixture.db.deliveryJob.findUnique({ where: { id } })).state, 'DEAD');
      assert.equal(await fixture.db.deliveryRetry.count(), 1);
    } finally {
      await fixture?.close();
      await identity.close();
      await cleanBroker(namespace);
    }
  },
);
