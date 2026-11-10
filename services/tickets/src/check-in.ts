import { createHash } from 'node:crypto';
import { ApiError } from '@eventflow/service-runtime';
import {
  checkInResult,
  type AdmissionWindow,
  type CheckInInput,
  type CheckInResult,
  type OfflineResult,
} from '@eventflow/event-contracts';
import type { Database } from './database';
import type { OfflineSession, Prisma } from './generated/client';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type LockedTicket = {
  id: string;
  orderId: string;
  saleId: string;
  organizationId: string;
  usedAt: Date | null;
};

export type OfflineContext = { sessionId: string; deviceId: string; capturedAt: string };

type AdmissionState = {
  ticket: LockedTicket | undefined;
  checkedAt: Date;
  refundState: string | undefined;
};

type AdmissionDecision =
  | { result: 'ADMITTED'; admittedAt: Date; reason: null; ticketId: string }
  | {
      result: Exclude<CheckInResult, 'ADMITTED'>;
      admittedAt: Date | null;
      reason: OfflineResult['reason'];
    };

async function loadOfflineSession(
  tx: Prisma.TransactionClient,
  actorSubject: string,
  { organizationId, eventId }: CheckInInput,
  offline: OfflineContext | undefined,
) {
  if (!offline) return null;
  const session = await tx.offlineSession.findUnique({ where: { id: offline.sessionId } });
  if (
    !session ||
    session.actorSubject !== actorSubject ||
    session.deviceId !== offline.deviceId ||
    session.organizationId !== organizationId ||
    session.eventId !== eventId
  )
    throw new ApiError(403, 'FORBIDDEN', 'Сессия недоступна.');
  return session;
}

async function lockAdmissionState(
  tx: Prisma.TransactionClient,
  credentialHash: string,
): Promise<AdmissionState> {
  const candidate = await tx.ticket.findUnique({
    where: { qrHash: credentialHash },
    select: { orderId: true },
  });
  if (candidate)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.orderId}, 1))`;
  const [ticket] = await tx.$queryRaw<LockedTicket[]>`
    SELECT id, "orderId", "saleId", "organizationId", "usedAt" FROM "Ticket"
      WHERE "qrHash" = ${credentialHash} FOR UPDATE`;
  // Sample the decision time after the row lock so time spent waiting counts.
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (!clock) throw new Error('Database clock unavailable');
  const gate = ticket
    ? await tx.refundGate.findUnique({ where: { orderId: ticket.orderId } })
    : null;
  return { ticket, checkedAt: clock.now, refundState: gate?.state };
}

function decideAdmission(
  { ticket, checkedAt, refundState }: AdmissionState,
  { organizationId, eventId }: CheckInInput,
  window: AdmissionWindow,
  session: Pick<OfflineSession, 'expiresAt' | 'hashes'> | null,
  credentialHash: string,
): AdmissionDecision {
  if (session && checkedAt >= session.expiresAt)
    return { result: 'WINDOW_CLOSED', admittedAt: null, reason: 'SNAPSHOT_EXPIRED' };
  if (session && !session.hashes.includes(credentialHash))
    return { result: 'INVALID_TICKET', admittedAt: null, reason: 'NOT_IN_SNAPSHOT' };
  if (
    checkedAt < new Date(window.admissionStartsAt) ||
    checkedAt >= new Date(window.admissionEndsAt)
  )
    return { result: 'WINDOW_CLOSED', admittedAt: null, reason: null };
  if (!ticket) return { result: 'INVALID_TICKET', admittedAt: null, reason: null };
  if (ticket.saleId !== eventId || ticket.organizationId !== organizationId)
    return { result: 'WRONG_EVENT', admittedAt: null, reason: null };
  if (refundState === 'REVOKED') return { result: 'REFUNDED', admittedAt: null, reason: null };
  if (refundState === 'LOCKED') return { result: 'REFUND_PENDING', admittedAt: null, reason: null };
  if (ticket.usedAt) return { result: 'ALREADY_USED', admittedAt: ticket.usedAt, reason: null };
  return { result: 'ADMITTED', admittedAt: checkedAt, reason: null, ticketId: ticket.id };
}

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
          ...(offline ? { reason: previous.offlineReason as OfflineResult['reason'] } : {}),
        };
      }

      const session = await loadOfflineSession(tx, actorSubject, input, offline);
      const state = await lockAdmissionState(tx, credentialHash);
      const decision = decideAdmission(state, input, window, session, credentialHash);
      if (decision.result === 'ADMITTED') {
        await tx.ticket.update({
          where: { id: decision.ticketId, usedAt: null },
          data: { usedAt: decision.admittedAt },
        });
      }
      const { result, admittedAt, reason } = decision;
      await tx.checkIn.create({
        data: {
          requestId,
          requestHash,
          actorSubject,
          organizationId,
          eventId,
          ticketId: state.ticket?.id ?? null,
          result,
          admittedAt,
          checkedAt: state.checkedAt,
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
