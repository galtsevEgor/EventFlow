import { Body, Controller, Get, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { z } from 'zod';
import { Database } from './database';
import type { PaymentAttempt, RefundOperation } from './generated/client';

@Controller('internal/payments')
export class PaymentOperator {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  @Post('reconcile')
  @HttpCode(202)
  async reconcile(
    @Headers('authorization') auth: string | undefined,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() input: unknown,
  ) {
    const actor = await this.verifier.service(auth, 'eventflow-operator', 'payments-reconcile');
    const key = parseInput(z.uuid(), rawKey).toLowerCase();
    const data = parseInput(
      z.strictObject({
        kind: z.enum(['payment', 'refund']),
        targetId: z.uuid(),
        reason: z.string().trim().min(8).max(240),
      }),
      input,
    );
    const targetId = data.targetId.toLowerCase();
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 2))`;
      const previous = await tx.operatorAction.findUnique({ where: { key } });
      if (previous) {
        if (
          previous.actor !== actor.subject ||
          previous.kind !== data.kind ||
          previous.targetId !== targetId ||
          previous.reason !== data.reason
        )
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Ключ использован для другого действия.');
        return;
      }
      if (data.kind === 'refund') {
        const [refund] = await tx.$queryRaw<
          RefundOperation[]
        >`SELECT * FROM "RefundOperation" WHERE id = ${targetId}::uuid FOR UPDATE`;
        if (!refund) throw new ApiError(404, 'NOT_FOUND', 'Возврат не найден.');
        if (refund.state !== 'SUCCEEDED') {
          await tx.refundOperation.update({
            where: { id: targetId },
            data: {
              state: 'UNKNOWN',
              failures: 0,
              reviewCode: null,
              nextRunAt: new Date(0),
            },
          });
          await tx.paymentAttempt.update({
            where: { id: refund.attemptId },
            data: { bookingState: 'REFUND_PENDING' },
          });
        }
      } else {
        const [attempt] = await tx.$queryRaw<
          PaymentAttempt[]
        >`SELECT * FROM "PaymentAttempt" WHERE id = ${targetId}::uuid FOR UPDATE`;
        if (!attempt) throw new ApiError(404, 'NOT_FOUND', 'Платёж не найден.');
        if (attempt.reviewCode === 'BOOKING_BINDING_REVIEW')
          throw new ApiError(
            409,
            'INVESTIGATION_REQUIRED',
            'Сначала разберите несовпадение привязки платежа.',
          );
        if (!['SUCCEEDED', 'CANCELLED'].includes(attempt.state))
          await tx.paymentAttempt.update({
            where: { id: targetId },
            data: {
              state: 'NEEDS_RECONCILIATION',
              failures: 0,
              reviewCode: null,
              nextRunAt: new Date(0),
            },
          });
      }
      await tx.operatorAction.create({
        data: { key, actor: actor.subject, kind: data.kind, targetId, reason: data.reason },
      });
    });
    return { accepted: true };
  }
  @Get('review')
  async review(@Headers('authorization') auth: string | undefined) {
    await this.verifier.service(auth, 'eventflow-operator', 'payments-reconcile');
    const [payments, refunds, webhooks] = await Promise.all([
      this.db.paymentAttempt.findMany({
        where: {
          OR: [
            { state: { in: ['NEEDS_RECONCILIATION', 'REQUIRES_REVIEW'] } },
            { bookingState: 'REQUIRES_REVIEW' },
          ],
        },
        take: 100,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          orderId: true,
          state: true,
          bookingState: true,
          reviewCode: true,
          updatedAt: true,
        },
      }),
      this.db.refundOperation.findMany({
        where: { state: { in: ['UNKNOWN', 'REQUIRES_REVIEW'] } },
        take: 100,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, orderId: true, state: true, reviewCode: true, createdAt: true },
      }),
      this.db.providerWebhook.findMany({
        where: { reviewCode: { not: null } },
        take: 100,
        orderBy: [{ createdAt: 'asc' }, { eventId: 'asc' }],
        select: { eventId: true, type: true, reviewCode: true, createdAt: true },
      }),
    ]);
    return { payments, refunds, webhooks };
  }
}
