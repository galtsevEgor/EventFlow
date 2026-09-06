import { provisionResultSchema, type EventEnvelope } from '@eventflow/event-contracts';
import { PermanentMessageError } from '@eventflow/messaging';
import { Database } from '../database';
import { lockOrganization } from '../organizations/access';
import { AvailabilityConsumer } from './availability-consumer';
import { publicProjection } from '../public-catalog/projection';

export class PublicationConsumer {
  constructor(private readonly db: Database) {}
  async handle(event: EventEnvelope) {
    if (event.eventType === 'SaleAvailabilityChanged.v1')
      return new AvailabilityConsumer(this.db).handle(event);
    const result = provisionResultSchema.safeParse(event.data);
    if (event.producer !== 'booking' || event.eventType !== 'SaleProvisioned.v1' || !result.success)
      throw new PermanentMessageError('Invalid publication confirmation');
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
        throw new PermanentMessageError('Publication snapshot mismatch');
      // Read the current cover under the organization lock: it may change during provisioning.
      const current = await tx.eventDraft.findUniqueOrThrow({ where: { id: draft.id } });
      if (publication.state !== 'PUBLISHED') {
        await tx.publicEvent.create({ data: publicProjection(draft.id, current.configuration) });
        await tx.publication.update({
          where: { eventId: draft.id },
          data: { state: 'PUBLISHED', publishedAt: new Date() },
        });
        if (current.coverId)
          await tx.coverAsset.update({ where: { id: current.coverId }, data: { isPublic: true } });
      }
      await tx.inbox.create({ data: { eventId: event.eventId } });
    });
  }
}
