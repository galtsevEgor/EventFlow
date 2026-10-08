import type { Schemas } from '@eventflow/api-client';

type Payment = Pick<Schemas['PaymentStatus'], 'state' | 'bookingState' | 'refundState' | 'canPay'>;

export function paymentPolling(
  payment: Payment | null | undefined,
  orderState: Schemas['Order']['state'],
  live: boolean,
  failed = false,
) {
  if (failed) return 3000;
  if (payment === null && orderState !== 'HELD') return false;
  if (!payment) return 3000;
  if (
    ['CONFIRMED', 'REFUNDED', 'REQUIRES_REVIEW'].includes(payment.bookingState) ||
    ['CANCELLED', 'REQUIRES_REVIEW'].includes(payment.state) ||
    payment.refundState === 'REQUIRES_REVIEW'
  )
    return live ? 30000 : false;
  // An open stream is not proof that a pending transition has been delivered.
  return live && payment.canPay ? 30000 : 3000;
}
