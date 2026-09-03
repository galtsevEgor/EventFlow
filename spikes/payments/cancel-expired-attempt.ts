export type PaymentStatus = 'requires_action' | 'processing' | 'succeeded' | 'canceled';

export interface PaymentGateway {
  cancel(attemptId: string): Promise<{ status: PaymentStatus }>;
}

// A normalized provider result must never turn an expired order into a confirmed order.
export async function cancelExpiredAttempt(gateway: PaymentGateway, attemptId: string) {
  const payment = await gateway.cancel(attemptId);
  switch (payment.status) {
    case 'canceled':
      return 'canceled';
    case 'succeeded':
      return 'refund-required';
    case 'processing':
    case 'requires_action':
      return 'reconcile';
  }
}
