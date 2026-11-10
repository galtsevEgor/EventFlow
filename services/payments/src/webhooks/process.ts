import type { Database } from '../database';
import { ProviderMismatch, type PaymentProvider } from '../providers/provider';
import { matches } from '../attempts/process';
import type { ProviderWebhook } from '../generated/client';
import {
  currentTelemetry,
  observedJob,
  operation,
  linkTrace,
  traceFailure,
  type Telemetry,
} from '@eventflow/telemetry';
import { PAYMENT_REVIEW_FAILURE_THRESHOLD, paymentRetryAt } from '../processing-policy';

const MAX_WEBHOOKS_PER_PASS = 20;

export class ProcessWebhooks {
  private telemetry: Telemetry | undefined;
  onModuleInit() {
    this.telemetry = currentTelemetry();
  }
  constructor(
    private readonly db: Database,
    private readonly provider: PaymentProvider,
  ) {}
  async run() {
    const pending = await this.db.$queryRaw<ProviderWebhook[]>`
      SELECT * FROM "ProviderWebhook" WHERE "processedAt" IS NULL AND "nextRunAt" <= clock_timestamp()
      ORDER BY "createdAt", "eventId" LIMIT ${MAX_WEBHOOKS_PER_PASS}`;
    for (const receipt of pending) {
      await observedJob(
        this.telemetry ?? currentTelemetry(),
        'payment.webhook',
        async () => {
          try {
            let attempt = await this.db.paymentAttempt.findUnique({
              where: { providerPaymentId: receipt.objectId },
            });
            if (!attempt) {
              const payment = await operation('payment.provider.retrieve', () =>
                this.provider.retrieve(receipt.objectId),
              );
              attempt = await this.db.paymentAttempt.findUnique({
                where: { id: payment.attemptId },
              });
              if (attempt && !matches(attempt, payment)) throw new ProviderMismatch();
              if (attempt?.authorized)
                await this.db.paymentAttempt.updateMany({
                  where: { id: attempt.id, providerPaymentId: null },
                  data: { providerPaymentId: payment.id },
                });
            }
            if (!attempt || attempt.provider !== this.provider.name) throw new ProviderMismatch();
            linkTrace(attempt.traceparent);
            await this.db.$transaction(async (tx) => {
              const claimed = await tx.providerWebhook.updateMany({
                where: { eventId: receipt.eventId, processedAt: null },
                data: { processedAt: new Date(), reviewCode: null },
              });
              if (!claimed.count) return;
              await tx.paymentAttempt.update({
                where: { id: attempt.id },
                data: { nextRunAt: new Date(0) },
              });
              await tx.refundOperation.updateMany({
                where: { attemptId: attempt.id },
                data: { nextRunAt: new Date(0) },
              });
            });
          } catch (error) {
            traceFailure();
            const mismatch = error instanceof ProviderMismatch;
            const review = mismatch || receipt.failures >= PAYMENT_REVIEW_FAILURE_THRESHOLD;
            await this.db.providerWebhook.updateMany({
              where: { eventId: receipt.eventId, processedAt: null },
              data: {
                failures: { increment: 1 },
                nextRunAt: paymentRetryAt(receipt.failures),
                ...(review
                  ? {
                      processedAt: new Date(),
                      reviewCode: mismatch ? 'UNKNOWN_OR_MISMATCHED_PAYMENT' : 'RETRY_LIMIT',
                    }
                  : {}),
              },
            });
          }
        },
        { parent: receipt.traceparent, attempt: receipt.failures },
      );
    }
  }
}
