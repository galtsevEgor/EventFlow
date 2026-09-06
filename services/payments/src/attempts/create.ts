import { randomUUID } from 'node:crypto';
import { ApiError, parseInput } from '@eventflow/service-runtime';
import { z } from 'zod';
import type { Database } from '../database';
import type { BookingClient } from '../booking-client';
import type { PaymentProvider } from '../providers/provider';

export class CreateAttempt {
  constructor(
    private readonly db: Database,
    private readonly booking: BookingClient,
    private readonly provider: PaymentProvider,
  ) {}
  async run(buyer: string, orderId: string, rawKey: string | undefined, token: string) {
    const key = parseInput(z.uuid(), rawKey).toLowerCase();
    const previous = await this.db.paymentRequest.findUnique({
      where: { buyerSubject_key: { buyerSubject: buyer, key } },
    });
    if (previous) {
      if (previous.orderId !== orderId)
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Ключ использован для другого заказа.');
      return { attemptId: previous.attemptId, orderId };
    }
    const existing = await this.db.paymentAttempt.findUnique({ where: { orderId } });
    if (existing && existing.buyerSubject !== buyer)
      throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден.');
    const order = existing ? null : await this.booking.buyerOrder(orderId, token);
    if (order && this.provider.name === 'stripe' && order.amountMinor < 50)
      throw new ApiError(
        422,
        'PAYMENT_AMOUNT_UNSUPPORTED',
        'Минимальная сумма тестовой оплаты — 0,50 €.',
      );
    if (order && (order.buyerSubject !== buyer || order.state !== 'HELD'))
      throw new ApiError(409, 'HOLD_EXPIRED', 'Бронь больше не доступна для оплаты.');
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${buyer}:${key}`}, 0))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orderId}, 1))`;
      const replay = await tx.paymentRequest.findUnique({
        where: { buyerSubject_key: { buyerSubject: buyer, key } },
      });
      if (replay) {
        if (replay.orderId !== orderId)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Ключ использован для другого заказа.');
        return { attemptId: replay.attemptId, orderId };
      }
      let attempt = await tx.paymentAttempt.findUnique({ where: { orderId } });
      if (!attempt) {
        if (!order) throw new Error('Payable snapshot missing');
        attempt = await tx.paymentAttempt.create({
          data: {
            id: randomUUID(),
            orderId,
            buyerSubject: buyer,
            amountMinor: order.amountMinor,
            currency: order.currency,
            expiresAt: order.expiresAt,
            provider: this.provider.name,
          },
        });
      }
      await tx.paymentRequest.create({
        data: { buyerSubject: buyer, key, orderId, attemptId: attempt.id },
      });
      return { attemptId: attempt.id, orderId };
    });
  }
}
