import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { paymentsFixture } from '../helpers/payments.mjs';
import { pendingRefund } from '../helpers/payment-flow.mjs';
import { jsonRequest } from '../helpers/identity.mjs';
import { ProcessRefund } from '../../services/payments/dist/refunds/process.js';
let fixture, operator;
before(async () => {
  fixture = await paymentsFixture();
  operator = await fixture.identity.token('operator', {
    aud: 'eventflow-payments',
    azp: 'eventflow-operator',
    realm_access: { roles: ['payments-reconcile'] },
  });
});
after(async () => {
  await fixture?.close();
});
const request = (...args) => jsonRequest(fixture.origin, ...args);

test('operator role is separate from buyers, Payments identity and a forged role with wrong client', async () => {
  const { refund, buyer } = await pendingRefund(fixture);
  const body = { kind: 'refund', targetId: refund.id, reason: 'Check unknown provider result' };
  for (const token of [
    undefined,
    buyer,
    await fixture.identity.token('machine', {
      aud: 'eventflow-payments',
      azp: 'eventflow-payments',
      realm_access: { roles: ['payments-reconcile'] },
    }),
    await fixture.identity.token('operator-without-role', {
      aud: 'eventflow-payments',
      azp: 'eventflow-operator',
      realm_access: { roles: [] },
    }),
  ]) {
    const response = await request(
      '/internal/payments/reconcile',
      token,
      'POST',
      body,
      randomUUID(),
    );
    assert.ok([401, 403].includes(response.status));
  }
  assert.equal(await fixture.db.operatorAction.count(), 0);
});

test('operator retry is audited once, keeps operation ID and recovers a lost refund response', async () => {
  const { refund } = await pendingRefund(fixture);
  fixture.provider.inject('refund', { loseResponse: true });
  const processor = fixture.app.get(ProcessRefund);
  await processor.run(refund.id);
  await fixture.db.refundOperation.update({
    where: { id: refund.id },
    data: { state: 'REQUIRES_REVIEW', reviewCode: 'RETRY_LIMIT' },
  });
  const key = randomUUID(),
    body = { kind: 'refund', targetId: refund.id, reason: 'Provider is available after an outage' };
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request('/internal/payments/reconcile', operator, 'POST', body, key),
    ),
  );
  assert.ok(results.every((r) => r.status === 202));
  assert.equal(await fixture.db.operatorAction.count({ where: { key } }), 1);
  assert.equal(
    (
      await request(
        '/internal/payments/reconcile',
        operator,
        'POST',
        { ...body, reason: 'Different explanation' },
        key,
      )
    ).status,
    409,
  );
  await processor.run(refund.id);
  assert.equal(
    (await fixture.db.refundOperation.findUnique({ where: { id: refund.id } })).state,
    'SUCCEEDED',
  );
  assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
  assert.equal(
    (await request('/internal/payments/reconcile', operator, 'POST', body, randomUUID())).status,
    202,
  );
  assert.equal(
    (await fixture.db.refundOperation.findUnique({ where: { id: refund.id } })).state,
    'SUCCEEDED',
  );
});

test('reconciliation cannot override a booking binding review or change prices', async () => {
  const { attempt } = await pendingRefund(fixture);
  await fixture.db.paymentAttempt.update({
    where: { id: attempt.id },
    data: { bookingState: 'REQUIRES_REVIEW', reviewCode: 'BOOKING_BINDING_REVIEW' },
  });
  const body = {
    kind: 'payment',
    targetId: attempt.id,
    reason: 'Inspect the payment binding mismatch',
  };
  assert.equal(
    (await request('/internal/payments/reconcile', operator, 'POST', body, randomUUID())).status,
    409,
  );
  assert.equal(
    (
      await request(
        '/internal/payments/reconcile',
        operator,
        'POST',
        { ...body, amountMinor: 1 },
        randomUUID(),
      )
    ).status,
    422,
  );
  const review = await request('/internal/payments/review', operator);
  assert.equal(review.status, 200);
  assert.ok(review.body.payments.some((p) => p.id === attempt.id));
  assert.ok(!JSON.stringify(review.body).includes('buyerSubject'));
});
