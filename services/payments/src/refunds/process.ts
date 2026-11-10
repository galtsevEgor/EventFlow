import { randomUUID } from 'node:crypto';
import { message } from '@eventflow/event-contracts';
import type { Database } from '../database';
import type { RefundOperation } from '../generated/client';
import { ProviderMismatch, type PaymentProvider, type ProviderRefund } from '../providers/provider';
import { paymentUpdate } from '../updates';
import {
  currentTelemetry,
  observedJob,
  operation as observeProvider,
  traceFailure,
  type Telemetry,
} from '@eventflow/telemetry';
import {
  PAYMENT_PROCESSING_LEASE_SECONDS,
  PAYMENT_REVIEW_FAILURE_THRESHOLD,
  paymentRetryAt,
  providerResendWindowExpired,
} from '../processing-policy';

const REFUND_RECHECK_INTERVAL_MS = 60_000;

export class ProcessRefund {
  private telemetry: Telemetry | undefined;
  onModuleInit() {
    this.telemetry = currentTelemetry();
  }
  constructor(
    private readonly db: Database,
    private readonly provider: PaymentProvider,
  ) {}
  async run(id?: string) {
    const lease = randomUUID();
    const [operation] = await this.db.$queryRaw<RefundOperation[]>`
      UPDATE "RefundOperation" SET lease = ${lease}::uuid,
        "leaseUntil" = clock_timestamp() + ${PAYMENT_PROCESSING_LEASE_SECONDS}::integer * interval '1 second'
      WHERE id = (SELECT id FROM "RefundOperation" WHERE
        (${id ?? null}::uuid IS NULL OR id = ${id ?? null}::uuid)
        AND state IN ('PENDING', 'UNKNOWN') AND "nextRunAt" <= clock_timestamp()
        AND ("leaseUntil" IS NULL OR "leaseUntil" < clock_timestamp())
        ORDER BY "nextRunAt", id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
    if (!operation) return false;
    await observedJob(
      this.telemetry ?? currentTelemetry(),
      'payment.refund',
      async () => {
        try {
          const attempt = await this.db.paymentAttempt.findUnique({
            where: { id: operation.attemptId },
          });
          if (
            !attempt ||
            attempt.provider !== this.provider.name ||
            !attempt.successPublished ||
            attempt.providerPaymentId !== operation.providerPaymentId ||
            attempt.amountMinor !== operation.amountMinor ||
            attempt.orderId !== operation.orderId ||
            attempt.currency !== operation.currency
          )
            throw new ProviderMismatch();
          const input = {
            operationId: operation.id,
            paymentId: operation.providerPaymentId,
            amountMinor: operation.amountMinor,
          };
          // A lost response is reconciled before any retry. The key and full amount never change.
          let result = await observeProvider('payment.provider.find_refund', () =>
            this.provider.findRefund(input),
          );
          if (!result) {
            if (providerResendWindowExpired(operation.createdAt)) throw new ProviderMismatch();
            result = await observeProvider('payment.provider.refund', () =>
              this.provider.refund(input),
            );
          }
          if (
            result.operationId !== operation.id ||
            result.paymentId !== operation.providerPaymentId ||
            result.amountMinor !== operation.amountMinor ||
            (operation.providerRefundId && operation.providerRefundId !== result.id)
          )
            throw new ProviderMismatch();
          await this.settle(operation, lease, result);
        } catch (error) {
          traceFailure();
          const mismatch = error instanceof ProviderMismatch;
          const review = mismatch || operation.failures >= PAYMENT_REVIEW_FAILURE_THRESHOLD;
          await this.db.$transaction(async (tx) => {
            const changed = await tx.refundOperation.updateMany({
              where: { id: operation.id, lease },
              data: {
                state: review ? 'REQUIRES_REVIEW' : 'UNKNOWN',
                failures: { increment: 1 },
                reviewCode: mismatch ? 'REFUND_BINDING_MISMATCH' : review ? 'RETRY_LIMIT' : null,
                nextRunAt: paymentRetryAt(operation.failures),
                lease: null,
                leaseUntil: null,
              },
            });
            if (changed.count && operation.state !== (review ? 'REQUIRES_REVIEW' : 'UNKNOWN'))
              await paymentUpdate(tx, operation.orderId);
            if (changed.count && review) {
              await tx.paymentAttempt.update({
                where: { id: operation.attemptId },
                data: { bookingState: 'REQUIRES_REVIEW' },
              });
              const event = message(
                'payments',
                operation.reason === 'ORGANIZER_REQUESTED'
                  ? 'ConfirmedOrderRefundReviewRequired.v1'
                  : 'RefundReviewRequired.v1',
                operation.orderId,
                1,
                {
                  operationId: operation.id,
                  attemptId: operation.attemptId,
                  orderId: operation.orderId,
                  providerPaymentId: operation.providerPaymentId,
                  state: 'REQUIRES_REVIEW',
                  providerRefundId: operation.providerRefundId,
                  code: 'RECONCILIATION_REQUIRED',
                },
              );
              await tx.outbox.create({ data: { id: event.eventId, envelope: event } });
            }
          });
        }
      },
      { parent: operation.traceparent, attempt: operation.failures },
    );
    return true;
  }
  private async settle(operation: RefundOperation, lease: string, result: ProviderRefund) {
    await this.db.$transaction(async (tx) => {
      const state =
        result.status === 'succeeded'
          ? 'SUCCEEDED'
          : result.status === 'failed'
            ? 'REQUIRES_REVIEW'
            : 'PENDING';
      const changed = await tx.refundOperation.updateMany({
        where: { id: operation.id, lease },
        data: {
          state,
          providerRefundId: result.id,
          reviewCode: result.status === 'failed' ? 'PROVIDER_REFUND_FAILED' : null,
          failures: 0,
          nextRunAt: new Date(Date.now() + REFUND_RECHECK_INTERVAL_MS),
          lease: null,
          leaseUntil: null,
        },
      });
      if (!changed.count) return;
      if (state !== operation.state || operation.providerRefundId !== result.id)
        await paymentUpdate(tx, operation.orderId);
      if (state === 'PENDING') return;
      await tx.paymentAttempt.update({
        where: { id: operation.attemptId },
        data: {
          bookingState: state === 'SUCCEEDED' ? 'REFUNDED' : 'REQUIRES_REVIEW',
        },
      });
      const event = message(
        'payments',
        operation.reason === 'ORGANIZER_REQUESTED'
          ? state === 'SUCCEEDED'
            ? 'ConfirmedOrderRefundSucceeded.v1'
            : 'ConfirmedOrderRefundReviewRequired.v1'
          : state === 'SUCCEEDED'
            ? 'RefundSucceeded.v1'
            : 'RefundFailed.v1',
        operation.orderId,
        1,
        {
          operationId: operation.id,
          attemptId: operation.attemptId,
          orderId: operation.orderId,
          providerPaymentId: operation.providerPaymentId,
          providerRefundId: result.id,
          state,
          code: state === 'SUCCEEDED' ? null : 'PROVIDER_REFUND_FAILED',
        },
      );
      await tx.outbox.create({ data: { id: event.eventId, envelope: event } });
    });
  }
}
