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

type LockedTicket = { id: string; saleId: string; organizationId: string; usedAt: Date | null };

export class CheckInTicket {
  constructor(private readonly db: Database) {}

  async run(actorSubject: string, input: CheckInInput, window: AdmissionWindow) {
    const { requestId, organizationId, eventId } = input;
    const credentialHash = sha256(input.credential);
    const requestHash = sha256(
      JSON.stringify([actorSubject, organizationId, eventId, credentialHash]),
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
        return { result: checkInResult.parse(previous.result), admittedAt: previous.admittedAt };
      }

      const [ticket] = await tx.$queryRaw<LockedTicket[]>`
        SELECT id, "saleId", "organizationId", "usedAt" FROM "Ticket"
          WHERE "qrHash" = ${credentialHash} FOR UPDATE`;
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('Database clock unavailable');

      let result: CheckInResult;
      let admittedAt: Date | null = null;
      if (
        clock.now < new Date(window.admissionStartsAt) ||
        clock.now >= new Date(window.admissionEndsAt)
      ) {
        result = 'WINDOW_CLOSED';
      } else if (!ticket) {
        result = 'INVALID_TICKET';
      } else if (ticket.saleId !== eventId || ticket.organizationId !== organizationId) {
        result = 'WRONG_EVENT';
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
        },
      });
      return { result, admittedAt };
    });
  }
}
