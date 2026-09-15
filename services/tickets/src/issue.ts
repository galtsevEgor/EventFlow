import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { orderConfirmedSchema, type EventEnvelope } from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import { Database } from './database';
import { QrCredentials } from './qr-credentials';

@Injectable()
export class IssueTickets {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QrCredentials) private readonly credentials: QrCredentials,
  ) {}

  async handle(event: EventEnvelope) {
    const parsed = orderConfirmedSchema.safeParse(event.data);
    if (
      event.producer !== 'booking' ||
      event.eventType !== 'OrderConfirmed.v1' ||
      !parsed.success ||
      parsed.data.orderId !== event.aggregateId
    )
      throw new PermanentMessageError('Invalid order confirmation');

    const { orderId, buyerSubject, saleId, organizationId, items } = parsed.data;
    if (new Set(items.map(({ seatId }) => seatId)).size !== items.length)
      throw new PermanentMessageError('Duplicate seats in order confirmation');

    await this.db.$transaction(async (tx) => {
      const receipt = await tx.inbox.createMany({
        data: { eventId: event.eventId },
        skipDuplicates: true,
      });
      if (!receipt.count) return;

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orderId}, 1))`;
      // The order is issued atomically. A replay with a new event ID keeps the original tickets.
      if (await tx.ticket.findFirst({ where: { orderId }, select: { id: true } })) return;
      await tx.ticket.createMany({
        data: items.map(({ seatId, row, number, categoryName }) => {
          const id = randomUUID();
          return {
            id,
            orderId,
            saleId,
            organizationId,
            buyerSubject,
            seatId,
            row,
            number,
            categoryName,
            ...this.credentials.issue(id),
          };
        }),
      });
    });
  }
}
