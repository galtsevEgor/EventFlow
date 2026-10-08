import { Body, Controller, Get, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { z } from 'zod';
import { Database } from './database';
import { ReconcilePayment } from './ops/reconcile';

@Controller('internal/payments')
export class PaymentOperator {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(ReconcilePayment) private readonly recovery: ReconcilePayment,
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
    return this.recovery.run(actor.subject, key, data);
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
