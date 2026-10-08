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
    | 'recoveryKey'
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
    row.recoveryKey,
  );
}
export function refundVersion(
  row: Pick<
    RefundOperation,
    'state' | 'reviewCode' | 'failures' | 'nextRunAt' | 'leaseUntil' | 'recoveryKey'
  >,
) {
  return operationVersion(
    row.state,
    row.reviewCode,
    row.failures,
    row.nextRunAt,
    row.leaseUntil,
    row.recoveryKey,
  );
}
