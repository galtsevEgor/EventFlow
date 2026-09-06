import { ApiError } from '@eventflow/service-runtime';
import type { Database } from '../database';
import type { BookingClient } from '../booking-client';
import type { PaymentProvider } from '../providers/provider';
import { ProcessAttempt, matches } from './process';

export class ReadPayment {
  constructor(
    private readonly db: Database,
    private readonly booking: BookingClient,
    private readonly provider: PaymentProvider,
    private readonly processor: ProcessAttempt,
  ) {}
  async owned(orderId: string, buyer: string) {
    const attempt = await this.db.paymentAttempt.findFirst({
      where: { orderId, buyerSubject: buyer },
    });
    if (!attempt) throw new ApiError(404, 'NOT_FOUND', 'Платёж не найден.');
    return attempt;
  }
  async run(orderId: string, buyer: string) {
    const attempt = await this.owned(orderId, buyer);
    const refund = await this.db.refundOperation.findUnique({ where: { attemptId: attempt.id } });
    const result = {
      attemptId: attempt.id,
      orderId,
      provider: attempt.provider,
      state: attempt.state,
      bookingState: attempt.bookingState,
      amountMinor: attempt.amountMinor,
      currency: attempt.currency,
      refundState: refund?.state ?? null,
      reviewCode: refund?.reviewCode ?? attempt.reviewCode,
      canPay: false,
      clientSecret: null as string | null,
    };
    if (
      attempt.state === 'REQUIRES_ACTION' &&
      attempt.authorized &&
      attempt.providerPaymentId &&
      !attempt.cancelRequested &&
      attempt.bookingState === 'PENDING' &&
      attempt.provider === this.provider.name
    ) {
      const payment = await this.provider.retrieve(attempt.providerPaymentId).catch(async () => {
        await this.processor.wake(attempt.id);
        throw new ApiError(
          503,
          'PROVIDER_UNAVAILABLE',
          'Проверяем состояние платежа. Не оплачивайте повторно.',
        );
      });
      if (!matches(attempt, payment)) {
        await this.processor.wake(attempt.id);
        return result;
      }
      // Check Booking after the provider read; a slow create/read must not expose an expired form.
      const order = await this.booking.state(orderId);
      result.canPay = order.state === 'HELD' && payment.status === 'requires_action';
      if (result.canPay) result.clientSecret = payment.clientSecret ?? null;
      else await this.processor.wake(attempt.id);
    }
    return result;
  }
}
