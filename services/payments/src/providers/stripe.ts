import Stripe from 'stripe';
import { z } from 'zod';
import {
  InvalidWebhook,
  ProviderMismatch,
  ProviderUnavailable,
  type PaymentInput,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderRefund,
  type RefundInput,
  type WebhookPointer,
} from './provider';

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly stripe: Stripe;
  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
    client?: Stripe,
  ) {
    if (!secretKey.startsWith('sk_test_'))
      throw new Error('Only Stripe sandbox keys are supported');
    this.stripe =
      client ??
      new Stripe(secretKey, {
        apiVersion: '2026-09-30.endive',
        timeout: 8000,
        maxNetworkRetries: 0,
      });
  }
  private payment(value: Stripe.PaymentIntent): ProviderPayment {
    const metadata = z
      .object({ application: z.literal('eventflow'), orderId: z.uuid(), attemptId: z.uuid() })
      .safeParse(value.metadata);
    if (
      !metadata.success ||
      !Number.isSafeInteger(value.amount) ||
      value.amount <= 0 ||
      ![
        'requires_payment_method',
        'requires_confirmation',
        'requires_action',
        'processing',
        'succeeded',
        'canceled',
      ].includes(value.status) ||
      value.livemode ||
      value.currency !== 'eur' ||
      value.payment_method_types.length !== 1 ||
      value.payment_method_types[0] !== 'card' ||
      value.capture_method !== 'automatic' ||
      value.status === 'requires_capture' ||
      (value.status === 'succeeded' && value.amount_received !== value.amount)
    )
      throw new ProviderMismatch();
    const status =
      value.status === 'succeeded'
        ? 'succeeded'
        : value.status === 'canceled'
          ? 'cancelled'
          : value.status === 'processing'
            ? 'processing'
            : 'requires_action';
    return {
      id: value.id,
      orderId: metadata.data.orderId,
      attemptId: metadata.data.attemptId,
      amountMinor: value.amount,
      currency: 'EUR',
      status,
      ...(status === 'requires_action' && value.client_secret
        ? { clientSecret: value.client_secret }
        : {}),
    };
  }
  private async call<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ProviderMismatch) throw error;
      throw new ProviderUnavailable();
    }
  }
  create(input: PaymentInput) {
    return this.call(async () =>
      this.payment(
        await this.stripe.paymentIntents.create(
          {
            amount: input.amountMinor,
            currency: input.currency.toLowerCase(),
            allowed_payment_method_types: ['card'],
            capture_method: 'automatic',
            metadata: {
              application: 'eventflow',
              orderId: input.orderId,
              attemptId: input.attemptId,
            },
          },
          { idempotencyKey: `eventflow:payment:${input.attemptId}` },
        ),
      ),
    );
  }
  retrieve(id: string) {
    return this.call(async () => this.payment(await this.stripe.paymentIntents.retrieve(id)));
  }
  async cancel(id: string) {
    try {
      return this.payment(
        await this.stripe.paymentIntents.cancel(
          id,
          {},
          { idempotencyKey: `eventflow:cancel:${id}` },
        ),
      );
    } catch (error) {
      if (error instanceof ProviderMismatch) throw error;
      // Cancellation can race processing/success. A failure is not proof of cancellation.
      return this.retrieve(id);
    }
  }
  private refundResult(value: Stripe.Refund, input: RefundInput): ProviderRefund {
    const paymentId =
      typeof value.payment_intent === 'string' ? value.payment_intent : value.payment_intent?.id;
    if (
      value.metadata?.operationId !== input.operationId ||
      value.metadata?.application !== 'eventflow' ||
      paymentId !== input.paymentId ||
      value.amount !== input.amountMinor ||
      value.currency !== 'eur'
    )
      throw new ProviderMismatch();
    return {
      ...input,
      id: value.id,
      status:
        value.status === 'succeeded'
          ? 'succeeded'
          : value.status === 'failed' || value.status === 'canceled'
            ? 'failed'
            : 'pending',
    };
  }
  refund(input: RefundInput) {
    return this.call(async () =>
      this.refundResult(
        await this.stripe.refunds.create(
          {
            payment_intent: input.paymentId,
            amount: input.amountMinor,
            metadata: { application: 'eventflow', operationId: input.operationId },
          },
          { idempotencyKey: `eventflow:refund:${input.operationId}` },
        ),
        input,
      ),
    );
  }
  findRefund(input: RefundInput) {
    return this.call(async () => {
      const results = await this.stripe.refunds.list({
        payment_intent: input.paymentId,
        limit: 100,
      });
      if (results.has_more || results.data.length > 1) throw new ProviderMismatch();
      const result = results.data[0];
      return result ? this.refundResult(result, input) : null;
    });
  }
  verifyWebhook(raw: Buffer, signature: string | undefined): WebhookPointer {
    try {
      if (!signature || raw.length > 1024 * 1024) throw new InvalidWebhook();
      const event = this.stripe.webhooks.constructEvent(raw, signature, this.webhookSecret, 300);
      if (event.livemode !== false || event.account || !/^evt_[A-Za-z0-9]+$/.test(event.id))
        throw new InvalidWebhook();
      const allowed = [
        'payment_intent.succeeded',
        'payment_intent.payment_failed',
        'payment_intent.processing',
        'payment_intent.canceled',
        'refund.created',
        'refund.updated',
        'refund.failed',
      ];
      if (!allowed.includes(event.type)) throw new InvalidWebhook();
      const object = z
        .object({
          id: z.string().min(1).max(255),
          object: z.string(),
          livemode: z.boolean().optional(),
          payment_intent: z.string().optional(),
        })
        .parse(event.data.object);
      if (
        object.livemode === true ||
        (event.type.startsWith('payment_intent.') &&
          (object.livemode !== false || !/^pi_[A-Za-z0-9]+$/.test(object.id))) ||
        (event.type.startsWith('refund.') &&
          !/^pi_[A-Za-z0-9]+$/.test(object.payment_intent ?? '')) ||
        (event.type.startsWith('payment_intent.') && object.object !== 'payment_intent') ||
        (event.type.startsWith('refund.') && (object.object !== 'refund' || !object.payment_intent))
      )
        throw new InvalidWebhook();
      return {
        eventId: event.id,
        objectId: event.type.startsWith('refund.') ? object.payment_intent! : object.id,
        type: event.type,
      };
    } catch {
      throw new InvalidWebhook();
    }
  }
}
