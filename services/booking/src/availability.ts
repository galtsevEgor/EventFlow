import { availabilitySchema, message, type EventEnvelope } from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import { Database } from './database';

export class ChangeAvailability {
  constructor(private readonly db: Database) {}
  async handle(event: EventEnvelope) {
    const result = availabilitySchema.safeParse(event.data);
    if (
      event.producer !== 'catalog' ||
      event.eventType !== 'SaleAvailabilityRequested.v1' ||
      !result.success
    )
      throw new PermanentMessageError('Invalid availability command');
    const { commandVersion, paused } = result.data;
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${event.aggregateId}, 0))`;
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      let sale = await tx.sale.findUnique({ where: { id: event.aggregateId } });
      if (!sale) throw new Error('Sale not provisioned yet');
      if (sale.version !== event.aggregateVersion)
        throw new PermanentMessageError('Sale version mismatch');
      if (commandVersion === sale.commandVersion && paused !== sale.paused)
        throw new PermanentMessageError('Conflicting command version');
      // Commands describe the complete desired state, so a newer version can safely skip a delayed one.
      if (commandVersion > sale.commandVersion)
        sale = await tx.sale.update({ where: { id: sale.id }, data: { commandVersion, paused } });
      const ack = message(
        'booking',
        'SaleAvailabilityChanged.v1',
        sale.id,
        sale.version,
        { commandVersion: sale.commandVersion, paused: sale.paused },
        event,
      );
      await tx.outbox.create({ data: { id: ack.eventId, envelope: ack } });
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }
}
