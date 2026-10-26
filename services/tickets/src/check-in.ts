import { createHash } from 'node:crypto';
import { ApiError } from '@eventflow/service-runtime';
import {
  checkInResult,
  type AdmissionWindow,
  type CheckInInput,
  type CheckInResult,
} from '@eventflow/event-contracts';
import type { Database } from './database';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type LockedTicket = {
  id: string;
  orderId: string;
  saleId: string;
  organizationId: string;
  usedAt: Date | null;
};

export type OfflineContext = { sessionId: string; deviceId: string; capturedAt: string };

export class CheckInTicket {
  constructor(private readonly db: Database) {}

  async run(
    actorSubject: string,
    input: CheckInInput,
    window: AdmissionWindow,
    offline?: OfflineContext,
  ) {
    const { requestId, organizationId, eventId } = input;
    const credentialHash = sha256(input.credential);
    const requestHash = sha256(
      JSON.stringify(
        offline
          ? [
              actorSubject,
              organizationId,
              eventId,
              credentialHash,
              offline.sessionId,
              offline.deviceId,
              offline.capturedAt,
            ]
          : [actorSubject, organizationId, eventId, credentialHash],
      ),
    );
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requestId}, 2))`;
      const previous = await tx.checkIn.findUnique({ where: { requestId } });
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Запрос уже использован для другой проверки.',
          );
        return {
          result: checkInResult.parse(previous.result),
          admittedAt: previous.admittedAt,
          ...(offline
            ? { reason: previous.offlineReason as 'SNAPSHOT_EXPIRED' | 'NOT_IN_SNAPSHOT' | null }
            : {}),
        };
      }

      const session = offline
        ? await tx.offlineSession.findUnique({ where: { id: offline.sessionId } })
        : null;
      if (
        offline &&
        (!session ||
          session.actorSubject !== actorSubject ||
          session.deviceId !== offline.deviceId ||
          session.organizationId !== organizationId ||
          session.eventId !== eventId)
      )
        throw new ApiError(403, 'FORBIDDEN', 'Сессия недоступна.');

      const candidate = await tx.ticket.findUnique({
        where: { qrHash: credentialHash },
        select: { orderId: true },
      });
      if (candidate)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.orderId}, 1))`;
      const [ticket] = await tx.$queryRaw<LockedTicket[]>`
        SELECT id, "orderId", "saleId", "organizationId", "usedAt" FROM "Ticket"
          WHERE "qrHash" = ${credentialHash} FOR UPDATE`;
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('Database clock unavailable');
      const gate = ticket
        ? await tx.refundGate.findUnique({ where: { orderId: ticket.orderId } })
        : null;

      let result: CheckInResult;
      let admittedAt: Date | null = null;
      let reason: 'SNAPSHOT_EXPIRED' | 'NOT_IN_SNAPSHOT' | null = null;
      if (session && clock.now >= session.expiresAt) {
        result = 'WINDOW_CLOSED';
        reason = 'SNAPSHOT_EXPIRED';
      } else if (session && !session.hashes.includes(credentialHash)) {
        result = 'INVALID_TICKET';
        reason = 'NOT_IN_SNAPSHOT';
      } else if (
        clock.now < new Date(window.admissionStartsAt) ||
        clock.now >= new Date(window.admissionEndsAt)
      ) {
        result = 'WINDOW_CLOSED';
      } else if (!ticket) {
        result = 'INVALID_TICKET';
      } else if (ticket.saleId !== eventId || ticket.organizationId !== organizationId) {
        result = 'WRONG_EVENT';
      } else if (gate?.state === 'REVOKED') {
        result = 'REFUNDED';
      } else if (gate?.state === 'LOCKED') {
        result = 'REFUND_PENDING';
      } else if (ticket.usedAt) {
        result = 'ALREADY_USED';
        admittedAt = ticket.usedAt;
      } else {
        await tx.ticket.update({
          where: { id: ticket.id, usedAt: null },
          data: { usedAt: clock.now },
        });
        result = 'ADMITTED';
        admittedAt = clock.now;
      }
      await tx.checkIn.create({
        data: {
          requestId,
          requestHash,
          actorSubject,
          organizationId,
          eventId,
          ticketId: ticket?.id ?? null,
          result,
          admittedAt,
          checkedAt: clock.now,
          ...(offline
            ? {
                offlineSessionId: offline.sessionId,
                capturedAt: new Date(offline.capturedAt),
                offlineReason: reason,
              }
            : {}),
        },
      });
      return { result, admittedAt, ...(offline ? { reason } : {}) };
    });
  }
}
