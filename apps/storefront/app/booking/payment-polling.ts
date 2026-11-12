import { LIVE_QUERY_RECHECK_INTERVAL_MS, type Schemas } from '@eventflow/api-client';

const UNRESOLVED_PAYMENT_POLL_INTERVAL_MS = 3_000;

type Payment = Pick<Schemas['PaymentStatus'], 'state' | 'bookingState' | 'refundState' | 'canPay'>;

export function paymentPolling(
  payment: Payment | null | undefined,
  orderState: Schemas['Order']['state'],
  live: boolean,
  failed = false,
) {
  if (failed) return UNRESOLVED_PAYMENT_POLL_INTERVAL_MS;
  if (payment === null && orderState !== 'HELD') return false;
  if (!payment) return UNRESOLVED_PAYMENT_POLL_INTERVAL_MS;
  if (
    ['CONFIRMED', 'REFUNDED', 'REQUIRES_REVIEW'].includes(payment.bookingState) ||
    ['CANCELLED', 'REQUIRES_REVIEW'].includes(payment.state) ||
    payment.refundState === 'REQUIRES_REVIEW'
  )
    return live ? LIVE_QUERY_RECHECK_INTERVAL_MS : false;
  // An open stream is not proof that a pending transition has been delivered.
  return live && payment.canPay
    ? LIVE_QUERY_RECHECK_INTERVAL_MS
    : UNRESOLVED_PAYMENT_POLL_INTERVAL_MS;
}
