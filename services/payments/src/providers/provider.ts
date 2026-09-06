export type PaymentInput = {
  attemptId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
};
export type ProviderPayment = PaymentInput & {
  id: string;
  status: 'requires_action' | 'processing' | 'succeeded' | 'cancelled';
  clientSecret?: string;
};
export type RefundInput = {
  operationId: string;
  paymentId: string;
  amountMinor: number;
};
export type ProviderRefund = RefundInput & {
  id: string;
  status: 'pending' | 'succeeded' | 'failed';
};
export type WebhookPointer = { eventId: string; objectId: string; type: string };

export interface PaymentProvider {
  readonly name: 'fake' | 'stripe';
  create(input: PaymentInput): Promise<ProviderPayment>;
  retrieve(id: string): Promise<ProviderPayment>;
  cancel(id: string): Promise<ProviderPayment>;
  refund(input: RefundInput): Promise<ProviderRefund>;
  findRefund(input: RefundInput): Promise<ProviderRefund | null>;
  verifyWebhook(raw: Buffer, signature: string | undefined): WebhookPointer;
}

// A transport failure never means that money did not move.
export class ProviderUnavailable extends Error {
  constructor() {
    super('Provider result is unknown');
  }
}
export class ProviderMismatch extends Error {
  constructor() {
    super('Provider binding does not match');
  }
}
export class InvalidWebhook extends Error {
  constructor() {
    super('Invalid provider webhook');
  }
}
