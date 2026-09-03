import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelExpiredAttempt,
  type PaymentGateway,
  type PaymentStatus,
} from './cancel-expired-attempt.ts';

class FakePaymentGateway implements PaymentGateway {
  constructor(private status: PaymentStatus) {}
  async cancel() {
    if (this.status === 'requires_action') this.status = 'canceled';
    return { status: this.status };
  }
  succeed() {
    if (this.status !== 'canceled') this.status = 'succeeded';
  }
}

test('cancelled payment stays cancelled on retry and cannot succeed afterwards', async () => {
  const gateway = new FakePaymentGateway('requires_action');
  assert.equal(await cancelExpiredAttempt(gateway, 'attempt'), 'canceled');
  gateway.succeed();
  assert.equal(await cancelExpiredAttempt(gateway, 'attempt'), 'canceled');
});
test('success winning the cancellation race requires a refund', async () => {
  const gateway = new FakePaymentGateway('requires_action');
  gateway.succeed();
  assert.equal(await cancelExpiredAttempt(gateway, 'attempt'), 'refund-required');
});
test('processing remains unresolved and provider errors require a retry', async () => {
  assert.equal(
    await cancelExpiredAttempt(new FakePaymentGateway('processing'), 'attempt'),
    'reconcile',
  );
  const unavailable: PaymentGateway = {
    cancel: async () => {
      throw new Error('provider unavailable');
    },
  };
  await assert.rejects(cancelExpiredAttempt(unavailable, 'attempt'), /provider unavailable/);
});
