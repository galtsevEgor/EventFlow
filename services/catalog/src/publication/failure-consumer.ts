import { provisionFailureSchema, type EventEnvelope } from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import { Database } from '../database';
import { lockOrganization } from '../organizations/access';

export class FailureConsumer {
  constructor(private readonly db: Database) {}
  async handle(event: EventEnvelope) {
    const result = provisionFailureSchema.safeParse(event.data);
    if (event.producer !== 'booking' || !event.causationId || !result.success)
      throw new PermanentMessageError('Invalid provisioning failure');
    await this.db.$transaction(async (tx) => {
      const draft = await tx.eventDraft.findUnique({ where: { id: event.aggregateId } });
      if (!draft) throw new PermanentMessageError('Unknown event');
      await lockOrganization(tx, draft.organizationId);
      if (await tx.inbox.findUnique({ where: { eventId: event.eventId } })) return;
      const publication = await tx.publication.findUnique({ where: { eventId: draft.id } });
      if (
        !publication ||
        publication.version !== event.aggregateVersion ||
        publication.snapshotHash !== result.data.snapshotHash
      )
        throw new PermanentMessageError('Failure snapshot mismatch');
      // Failure can only finish its own pending attempt; success is never rolled back.
      if (publication.state === 'PROVISIONING' && publication.requestId === event.causationId)
        await tx.publication.update({
          where: { eventId: draft.id },
          data: { state: 'FAILED', failureCode: result.data.code },
        });
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }
}
