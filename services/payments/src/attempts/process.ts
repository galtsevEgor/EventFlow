import { randomUUID } from 'node:crypto';
import { message } from '@eventflow/event-contracts';
import type { Database } from '../database';
import type { BookingClient } from '../booking-client';
import {
  ProviderMismatch,
  type PaymentProvider,
  type ProviderPayment,
} from '../providers/provider';
import type { PaymentAttempt } from '../generated/client';
import { paymentUpdate } from '../updates';

export function matches(attempt: PaymentAttempt, payment: ProviderPayment) {
  return (
    payment.attemptId === attempt.id &&
    payment.orderId === attempt.orderId &&
    payment.amountMinor === attempt.amountMinor &&
    payment.currency === attempt.currency &&
    (!attempt.providerPaymentId || attempt.providerPaymentId === payment.id)
  );
}
export class ProcessAttempt {
  constructor(
    private readonly db: Database,
    private readonly booking: BookingClient,
    private readonly provider: PaymentProvider,
  ) {}
  async run(id?: string) {
    const lease = randomUUID();
    const [attempt] = await this.db.$queryRaw<PaymentAttempt[]>`
      UPDATE "PaymentAttempt" SET lease = ${lease}::uuid, "leaseUntil" = clock_timestamp() + interval '60 seconds'
      WHERE id = (SELECT id FROM "PaymentAttempt" WHERE
        (${id ?? null}::uuid IS NULL OR id = ${id ?? null}::uuid)
        AND "nextRunAt" <= clock_timestamp() AND ("leaseUntil" IS NULL OR "leaseUntil" < clock_timestamp())
        AND state NOT IN ('CANCELLED', 'REQUIRES_REVIEW')
        AND (state <> 'SUCCEEDED' OR "bookingState" = 'PENDING')
        ORDER BY "nextRunAt", id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
    if (!attempt) return false;
    try {
      if (attempt.provider !== this.provider.name) throw new ProviderMismatch();
      if (!attempt.authorized) {
        const order = await this.booking.authorize(
          attempt.orderId,
          attempt.id,
          attempt.buyerSubject,
          this.provider.name,
        );
        if (order.state !== 'HELD') {
          await this.db.$transaction(async (tx) => {
            const changed = await tx.paymentAttempt.updateMany({
              where: { id: attempt.id, lease },
              data: { state: 'CANCELLED', lease: null, leaseUntil: null },
            });
            if (changed.count) await paymentUpdate(tx, attempt.orderId);
          });
          return true;
        }
        if (
          order.amountMinor !== attempt.amountMinor ||
          order.currency !== attempt.currency ||
          order.buyerSubject !== attempt.buyerSubject
        )
          throw new ProviderMismatch();
        const saved = await this.db.paymentAttempt.updateMany({
          where: { id: attempt.id, lease },
          data: { authorized: true },
        });
        if (!saved.count) return true;
      }
      // Never reuse a possibly pruned provider key to create a new payment after 23 hours.
      if (!attempt.providerPaymentId && Date.now() - +attempt.createdAt >= 23 * 3600_000)
        throw new ProviderMismatch();
      let payment = attempt.providerPaymentId
        ? await this.provider.retrieve(attempt.providerPaymentId)
        : await this.provider.create({
            attemptId: attempt.id,
            orderId: attempt.orderId,
            amountMinor: attempt.amountMinor,
            currency: attempt.currency,
          });
      if (!matches(attempt, payment)) throw new ProviderMismatch();
      await this.db.paymentAttempt.updateMany({
        where: { id: attempt.id, lease },
        data: { providerPaymentId: payment.id },
      });
      if (payment.status !== 'succeeded' && payment.status !== 'cancelled') {
        const order = await this.booking.state(attempt.orderId);
        const closed = await this.db.closedOrder.findUnique({
          where: { orderId: attempt.orderId },
        });
        if (attempt.cancelRequested || closed || order.state !== 'HELD')
          payment = await this.provider.cancel(payment.id);
      }
      await this.accept(attempt.id, lease, payment);
    } catch (error) {
      const review = error instanceof ProviderMismatch || attempt.failures >= 7;
      await this.db.$transaction(async (tx) => {
        const changed = await tx.paymentAttempt.updateMany({
          where: { id: attempt.id, lease },
          data: {
            ...(!attempt.successPublished
              ? { state: review ? 'REQUIRES_REVIEW' : 'NEEDS_RECONCILIATION' }
              : {}),
            ...(review
              ? {
                  ...(attempt.successPublished && attempt.bookingState === 'PENDING'
                    ? { bookingState: 'REQUIRES_REVIEW' }
                    : {}),
                  reviewCode:
                    error instanceof ProviderMismatch ? 'PROVIDER_BINDING_MISMATCH' : 'RETRY_LIMIT',
                }
              : {}),
            failures: { increment: 1 },
            nextRunAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** attempt.failures)),
            lease: null,
            leaseUntil: null,
          },
        });
        const next = review ? 'REQUIRES_REVIEW' : 'NEEDS_RECONCILIATION';
        if (
          changed.count &&
          ((!attempt.successPublished && attempt.state !== next) ||
            (review && attempt.bookingState === 'PENDING'))
        )
          await paymentUpdate(tx, attempt.orderId);
      });
    }
    return true;
  }
  private async accept(id: string, lease: string, payment: ProviderPayment) {
    await this.db.$transaction(async (tx) => {
      const [attempt] = await tx.$queryRaw<
        PaymentAttempt[]
      >`SELECT * FROM "PaymentAttempt" WHERE id = ${id}::uuid FOR UPDATE`;
      if (!attempt || attempt.lease !== lease) return;
      if (!matches(attempt, payment)) throw new ProviderMismatch();
      const succeeded = attempt.successPublished || payment.status === 'succeeded';
      const state = succeeded
        ? 'SUCCEEDED'
        : payment.status === 'cancelled'
          ? 'CANCELLED'
          : payment.status === 'processing'
            ? 'PROCESSING'
            : 'REQUIRES_ACTION';
      if (payment.status === 'succeeded' && !attempt.successPublished) {
        const event = message('payments', 'PaymentSucceeded.v1', attempt.orderId, 1, {
          orderId: attempt.orderId,
          attemptId: attempt.id,
          providerPaymentId: payment.id,
          buyerSubject: attempt.buyerSubject,
          amountMinor: attempt.amountMinor,
          currency: attempt.currency,
          verifiedAt: new Date().toISOString(),
          provider: attempt.provider,
        });
        await tx.outbox.create({ data: { id: event.eventId, envelope: event } });
      }
      await tx.paymentAttempt.update({
        where: { id },
        data: {
          state,
          providerPaymentId: payment.id,
          successPublished: succeeded,
          failures: 0,
          nextRunAt: new Date(Date.now() + 60_000 + Math.floor(Math.random() * 5000)),
          lease: null,
          leaseUntil: null,
        },
      });
      if (state !== attempt.state || payment.id !== attempt.providerPaymentId)
        await paymentUpdate(tx, attempt.orderId);
    });
  }
  async wake(id: string) {
    await this.db.paymentAttempt.updateMany({ where: { id }, data: { nextRunAt: new Date(0) } });
  }
}
