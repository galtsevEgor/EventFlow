import { ApiError, type UserIdentity } from '@eventflow/service-runtime';
import { message } from '@eventflow/event-contracts';
import { Database } from '../database';
import { lockOrganization, requireMembership } from '../organizations/access';
import { publicationSelect } from './view';

export class AvailabilityService {
  constructor(private readonly db: Database) {}
  async change(
    actor: UserIdentity,
    organizationId: string,
    eventId: string,
    paused: boolean,
    expectedVersion: number,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await requireMembership(tx, actor, organizationId, ['OWNER', 'MANAGER']);
      const event = await tx.eventDraft.findFirst({
        where: { id: eventId, organizationId },
        include: { publication: true },
      });
      if (!event) throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
      const publication = event.publication;
      if (publication?.state !== 'PUBLISHED')
        throw new ApiError(409, 'NOT_PUBLISHED', 'Дождитесь подтверждения публикации.');
      if (publication.commandVersion !== expectedVersion)
        throw new ApiError(
          409,
          'COMMAND_CHANGED',
          'Состояние продаж уже изменено. Обновите страницу.',
        );
      if (publication.desiredPaused === paused)
        return tx.publication.findUniqueOrThrow({ where: { eventId }, select: publicationSelect });
      const updated = await tx.publication.update({
        where: { eventId },
        data: { desiredPaused: paused, commandVersion: { increment: 1 } },
        select: publicationSelect,
      });
      const envelope = message(
        'catalog',
        'SaleAvailabilityRequested.v1',
        eventId,
        publication.version,
        { commandVersion: updated.commandVersion, paused },
      );
      await tx.outbox.create({ data: { id: envelope.eventId, envelope } });
      await tx.auditEntry.create({
        data: {
          organizationId,
          actorSubject: actor.subject,
          action: paused ? 'sale.pause_requested' : 'sale.resume_requested',
          targetId: eventId,
          details: { commandVersion: updated.commandVersion },
        },
      });
      return updated;
    });
  }
}
