import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { paymentsDatabase } from '../helpers/payments-database.mjs';
import { FakePaymentProvider } from '../../services/payments/dist/providers/fake.js';
import {
  ProviderMismatch,
  ProviderUnavailable,
  InvalidWebhook,
} from '../../services/payments/dist/providers/provider.js';

let fixture;
before(async () => {
  fixture = await paymentsDatabase();
});
after(async () => {
  await fixture?.close();
});
const input = () => ({
  attemptId: randomUUID(),
  orderId: randomUUID(),
  amountMinor: 1500,
  currency: 'EUR',
});

test('lost create response and concurrent retries preserve one durable payment after restart', async () => {
  const provider = new FakePaymentProvider(fixture.db);
  const request = input();
  provider.inject('create', { loseResponse: true });
  await assert.rejects(provider.create(request), ProviderUnavailable);
  const restarted = new FakePaymentProvider(fixture.db);
  const results = await Promise.all(Array.from({ length: 20 }, () => restarted.create(request)));
  assert.equal(new Set(results.map((p) => p.id)).size, 1);
  assert.equal(await fixture.db.fakePayment.count({ where: { attemptId: request.attemptId } }), 1);
  await assert.rejects(restarted.create({ ...request, amountMinor: 1 }), ProviderMismatch);
  await assert.rejects(restarted.create({ ...request, orderId: randomUUID() }), ProviderMismatch);
});

test('unknown refund result is discoverable and concurrent retries never refund twice', async () => {
  const provider = new FakePaymentProvider(fixture.db);
  const payment = await provider.create(input());
  await provider.confirm(payment.id, 'success');
  const request = {
    operationId: randomUUID(),
    paymentId: payment.id,
    amountMinor: payment.amountMinor,
  };
  provider.inject('refund', { loseResponse: true });
  await assert.rejects(provider.refund(request), ProviderUnavailable);
  const restarted = new FakePaymentProvider(fixture.db);
  const found = await restarted.findRefund(request);
  assert.equal(found.status, 'succeeded');
  const results = await Promise.all(Array.from({ length: 10 }, () => restarted.refund(request)));
  assert.ok(results.every((r) => r.id === found.id));
  assert.equal(await fixture.db.fakeRefund.count({ where: { paymentId: payment.id } }), 1);
  await assert.rejects(
    provider.refund({ ...request, operationId: randomUUID() }),
    ProviderMismatch,
  );
});

test('cancel cannot erase processing/success and a cancelled payment cannot succeed', async () => {
  const provider = new FakePaymentProvider(fixture.db);
  const first = await provider.create(input());
  assert.equal((await provider.cancel(first.id)).status, 'cancelled');
  assert.equal((await provider.confirm(first.id, 'success')).status, 'cancelled');
  const second = await provider.create(input());
  await provider.confirm(second.id, 'processing');
  assert.equal((await provider.cancel(second.id)).status, 'processing');
  await provider.confirm(second.id, 'success');
  assert.equal((await provider.cancel(second.id)).status, 'succeeded');
  await provider.confirm(second.id, 'decline');
  assert.equal((await provider.retrieve(second.id)).status, 'succeeded');
});

test('fake does not accept provider webhooks and a failed request has no side effect', async () => {
  const provider = new FakePaymentProvider(fixture.db);
  assert.throws(() => provider.verifyWebhook(Buffer.from('{}'), 'forged'), InvalidWebhook);
  const request = input();
  provider.inject('create', { failBefore: true, delayMs: 5 });
  await assert.rejects(provider.create(request), ProviderUnavailable);
  assert.equal(await fixture.db.fakePayment.count({ where: { attemptId: request.attemptId } }), 0);
});

test('first concurrent create and refund calls are idempotent before any result exists', async () => {
  const provider = new FakePaymentProvider(fixture.db);
  const request = input();
  const payments = await Promise.all(Array.from({ length: 12 }, () => provider.create(request)));
  assert.equal(new Set(payments.map((p) => p.id)).size, 1);
  await provider.confirm(payments[0].id, 'success');
  const refund = {
    operationId: randomUUID(),
    paymentId: payments[0].id,
    amountMinor: request.amountMinor,
  };
  const results = await Promise.all(Array.from({ length: 12 }, () => provider.refund(refund)));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
});
