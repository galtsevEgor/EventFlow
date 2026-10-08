import { ApiError } from '@eventflow/service-runtime';
import { currentTraceparent, linkTrace } from '@eventflow/telemetry';
import type { Database } from '../database';
import type { PaymentAttempt, RefundOperation } from '../generated/client';
import { paymentVersion, refundVersion } from './versions';

export class ReconcilePayment {
  constructor(private readonly db: Database) {}
  async run(
    actor: string,
    key: string,
    input: { kind: 'payment' | 'refund'; targetId: string; reason: string },
    actorType: 'SERVICE' | 'HUMAN' = 'SERVICE',
    expectedVersion?: string,
  ) {
    if (actorType === 'HUMAN' && !expectedVersion)
      throw new ApiError(422, 'VERSION_REQUIRED', 'Обновите карточку перед действием.');
    const targetId = input.targetId.toLowerCase();
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},2))`;
      const previous = await tx.operatorAction.findUnique({ where: { key } });
      if (previous) {
        if (
          previous.actor !== actor ||
          previous.kind !== input.kind ||
          previous.targetId !== targetId ||
          previous.reason !== input.reason ||
          (previous.expectedVersion ?? null) !== (expectedVersion ?? null) ||
          (previous.actorType ?? 'SERVICE') !== actorType
        )
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Ключ использован для другого действия.');
        return;
      }
      if (input.kind === 'refund') {
        const [row] = await tx.$queryRaw<
          RefundOperation[]
        >`SELECT * FROM "RefundOperation" WHERE id=${targetId}::uuid FOR UPDATE`;
        if (!row) throw new ApiError(404, 'NOT_FOUND', 'Возврат не найден.');
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        if (!clock)
          throw new ApiError(
            503,
            'DATABASE_UNAVAILABLE',
            'Не удалось проверить состояние операции.',
          );
        const now = clock.now;
        this.checkLease(row.leaseUntil, now);
        if (expectedVersion && expectedVersion !== refundVersion(row))
          throw new ApiError(409, 'STALE_OPERATION', 'Запись изменилась. Обновите карточку.');
        if (actorType === 'HUMAN' && !['UNKNOWN', 'REQUIRES_REVIEW'].includes(row.state))
          throw new ApiError(409, 'NOT_RECOVERABLE', 'Сверка сейчас не требуется.');
        linkTrace(row.traceparent);
        if (row.state !== 'SUCCEEDED') {
          await tx.refundOperation.update({
            where: { id: targetId },
            data: {
              state: 'UNKNOWN',
              failures: 0,
              reviewCode: null,
              nextRunAt: now,
              recoveryKey: key,
              traceparent: currentTraceparent() ?? row.traceparent,
            },
          });
          await tx.paymentAttempt.update({
            where: { id: row.attemptId },
            data: { bookingState: 'REFUND_PENDING' },
          });
        }
      } else {
        const [row] = await tx.$queryRaw<
          PaymentAttempt[]
        >`SELECT * FROM "PaymentAttempt" WHERE id=${targetId}::uuid FOR UPDATE`;
        if (!row) throw new ApiError(404, 'NOT_FOUND', 'Платёж не найден.');
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        if (!clock)
          throw new ApiError(
            503,
            'DATABASE_UNAVAILABLE',
            'Не удалось проверить состояние операции.',
          );
        const now = clock.now;
        this.checkLease(row.leaseUntil, now);
        if (expectedVersion && expectedVersion !== paymentVersion(row))
          throw new ApiError(409, 'STALE_OPERATION', 'Запись изменилась. Обновите карточку.');
        if (row.reviewCode === 'BOOKING_BINDING_REVIEW')
          throw new ApiError(
            409,
            'INVESTIGATION_REQUIRED',
            'Сначала разберите несовпадение привязки платежа.',
          );
        if (
          actorType === 'HUMAN' &&
          !['NEEDS_RECONCILIATION', 'REQUIRES_REVIEW'].includes(row.state)
        )
          throw new ApiError(409, 'NOT_RECOVERABLE', 'Сверка сейчас не требуется.');
        linkTrace(row.traceparent);
        if (!['SUCCEEDED', 'CANCELLED'].includes(row.state))
          await tx.paymentAttempt.update({
            where: { id: targetId },
            data: {
              state: 'NEEDS_RECONCILIATION',
              failures: 0,
              reviewCode: null,
              nextRunAt: now,
              recoveryKey: key,
              traceparent: currentTraceparent() ?? row.traceparent,
            },
          });
      }
      await tx.operatorAction.create({
        data: {
          key,
          actor,
          actorType,
          kind: input.kind,
          targetId,
          reason: input.reason,
          expectedVersion: expectedVersion ?? null,
          traceparent: currentTraceparent() ?? null,
        },
      });
    });
    return { accepted: true };
  }
  private checkLease(until: Date | null, now: Date) {
    if (until && until > now)
      throw new ApiError(
        409,
        'OPERATION_BUSY',
        'Операцию обрабатывает worker. Повторите после обновления статуса.',
      );
  }
}
