import { createHash } from 'node:crypto';
import {
  message,
  orderRefundedSchema,
  ticketRefundLockSchema,
  type EventEnvelope,
} from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import type { Database } from './database';
import type { Ticket } from './generated/client';

export class TicketRefunds {
  constructor(private readonly db: Database) {}

  async handle(event: EventEnvelope) {
    if (event.producer !== 'booking') throw new PermanentMessageError('Invalid refund producer');
    if (event.eventType === 'OrderRefunded.v1') return this.revoke(event);
    const parsed = ticketRefundLockSchema.safeParse(event.data);
    if (
      event.eventType !== 'TicketRefundLockRequested.v1' ||
      !parsed.success ||
      parsed.data.orderId !== event.aggregateId
    )
      throw new PermanentMessageError('Invalid refund lock');
    const data = parsed.data;
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ ...data, seatIds: [...data.seatIds].sort() }))
      .digest('hex');
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${data.orderId}, 1))`;
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      const gate = await tx.refundGate.findUnique({ where: { orderId: data.orderId } });
      if (
        gate &&
        (gate.operationId !== data.operationId ||
          gate.saleId !== data.saleId ||
          gate.organizationId !== data.organizationId ||
          (gate.payloadHash && gate.payloadHash !== payloadHash))
      )
        throw new PermanentMessageError('Conflicting refund lock');
      // Row locks also serialize an older admission worker which does not take the order lock.
      const tickets = await tx.$queryRaw<
        Ticket[]
      >`SELECT * FROM "Ticket" WHERE "orderId" = ${data.orderId}::uuid ORDER BY id FOR UPDATE`;
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('Database clock unavailable');
      const mismatched =
        tickets.length > 0 &&
        (tickets.length !== data.seatIds.length ||
          tickets.some(
            (ticket) =>
              ticket.saleId !== data.saleId ||
              ticket.organizationId !== data.organizationId ||
              !data.seatIds.includes(ticket.seatId),
          ));
      const code = gate
        ? gate.code
        : mismatched
          ? 'TICKET_MISMATCH'
          : tickets.some((ticket) => ticket.usedAt)
            ? 'TICKETS_USED'
            : clock.now >= new Date(data.deadline)
              ? 'REFUND_WINDOW_CLOSED'
              : null;
      if (!gate)
        await tx.refundGate.create({
          data: {
            orderId: data.orderId,
            operationId: data.operationId,
            saleId: data.saleId,
            organizationId: data.organizationId,
            payloadHash,
            state: code ? 'REJECTED' : 'LOCKED',
            code,
          },
        });
      if (!code)
        await tx.deliveryJob.updateMany({
          where: { id: data.orderId, state: { in: ['PENDING', 'DEAD'] } },
          data: { state: 'SKIPPED', lease: null },
        });
      const reply = message(
        'tickets',
        code ? 'TicketRefundLockRejected.v1' : 'TicketRefundLocked.v1',
        data.orderId,
        1,
        {
          operationId: data.operationId,
          orderId: data.orderId,
          saleId: data.saleId,
          organizationId: data.organizationId,
          code,
        },
      );
      await tx.outbox.create({ data: { id: reply.eventId, envelope: reply } });
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }

  private async revoke(event: EventEnvelope) {
    const parsed = orderRefundedSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.orderId !== event.aggregateId)
      throw new PermanentMessageError('Invalid refunded order');
    const data = parsed.data;
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${data.orderId}, 1))`;
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      const gate = await tx.refundGate.findUnique({ where: { orderId: data.orderId } });
      if (
        gate &&
        (gate.operationId !== data.operationId ||
          gate.saleId !== data.saleId ||
          gate.organizationId !== data.organizationId ||
          gate.state === 'REJECTED')
      )
        throw new PermanentMessageError('Refund revocation scope mismatch');
      await tx.$queryRaw`SELECT id FROM "Ticket" WHERE "orderId" = ${data.orderId}::uuid ORDER BY id FOR UPDATE`;
      await tx.refundGate.upsert({
        where: { orderId: data.orderId },
        create: {
          orderId: data.orderId,
          operationId: data.operationId,
          saleId: data.saleId,
          organizationId: data.organizationId,
          state: 'REVOKED',
        },
        update: { state: 'REVOKED', updatedAt: new Date() },
      });
      await tx.deliveryJob.updateMany({
        where: { id: data.orderId, state: { in: ['PENDING', 'DEAD'] } },
        data: { state: 'SKIPPED', lease: null },
      });
      await tx.deliveryJob.createMany({ data: { id: data.operationId }, skipDuplicates: true });
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }
}
