import { operationVersion } from '@eventflow/service-runtime';
import type { PaymentAttempt, RefundOperation } from '../generated/client';

export function paymentVersion(
  row: Pick<
    PaymentAttempt,
    | 'state'
    | 'bookingState'
    | 'reviewCode'
    | 'failures'
    | 'nextRunAt'
    | 'leaseUntil'
    | 'cancelRequested'
    | 'authorized'
  >,
) {
  return operationVersion(
    row.state,
    row.bookingState,
    row.reviewCode,
    row.failures,
    row.nextRunAt,
    row.leaseUntil,
    row.cancelRequested,
    row.authorized,
  );
}
export function refundVersion(
  row: Pick<RefundOperation, 'state' | 'reviewCode' | 'failures' | 'nextRunAt' | 'leaseUntil'>,
) {
  return operationVersion(row.state, row.reviewCode, row.failures, row.nextRunAt, row.leaseUntil);
}
