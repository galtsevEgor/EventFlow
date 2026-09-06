import { availabilitySchema, type EventEnvelope } from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import { Database } from '../database';
import { lockOrganization } from '../organizations/access';

export class AvailabilityConsumer {
  constructor(private readonly db: Database) {}
  async handle(event: EventEnvelope) {
    const result = availabilitySchema.safeParse(event.data);
    if (event.producer !== 'booking' || !result.success)
      throw new PermanentMessageError('Invalid availability confirmation');
    const { commandVersion, paused } = result.data;
    await this.db.$transaction(async (tx) => {
      const draft = await tx.eventDraft.findUnique({ where: { id: event.aggregateId } });
      if (!draft) throw new PermanentMessageError('Unknown event');
      await lockOrganization(tx, draft.organizationId);
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      const publication = await tx.publication.findUnique({ where: { eventId: draft.id } });
      if (
        !publication ||
        publication.version !== event.aggregateVersion ||
        commandVersion > publication.commandVersion ||
        (commandVersion === publication.commandVersion && paused !== publication.desiredPaused)
      )
        throw new PermanentMessageError('Availability command mismatch');
      if (commandVersion > publication.acknowledgedVersion)
        await tx.publication.update({
          where: { eventId: draft.id },
          data: { acknowledgedVersion: commandVersion, acknowledgedPaused: paused },
        });
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }
}
