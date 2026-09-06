import { createHash } from 'node:crypto';
import { ApiError, parseInput, type UserIdentity } from '@eventflow/service-runtime';
import { message, provisionSchema } from '@eventflow/event-contracts';
import { Database } from '../database';
import { lockOrganization, requireMembership } from '../organizations/access';
import { configurationSchema, materializeSeats } from '../events/configuration';
import { publicationSelect } from './view';

export class PublicationService {
  constructor(private readonly db: Database) {}
  async publish(actor: UserIdentity, organizationId: string, eventId: string, revision: number) {
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await requireMembership(tx, actor, organizationId, ['OWNER', 'MANAGER']);
      const event = await tx.eventDraft.findFirst({
        where: { id: eventId, organizationId },
        include: { publication: { select: publicationSelect } },
      });
      if (!event) throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
      if (event.publication) return event.publication;
      if (event.revision !== revision)
        throw new ApiError(409, 'DRAFT_CHANGED', 'Черновик изменён. Обновите страницу.');
      if (!event.coverId || !event.description.trim())
        throw new ApiError(422, 'EVENT_INCOMPLETE', 'Добавьте афишу и описание перед публикацией.');
      const config = parseInput(configurationSchema, event.configuration);
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock || new Date(config.salesEndsAt) <= clock.now)
        throw new ApiError(422, 'SALES_ENDED', 'Окончание продаж должно быть в будущем.');
      const snapshot = provisionSchema.parse({
        organizationId,
        title: event.title,
        currency: config.currency,
        timeZone: config.timeZone,
        startsAt: config.startsAt,
        endsAt: config.endsAt,
        salesStartsAt: config.salesStartsAt,
        salesEndsAt: config.salesEndsAt,
        admissionStartsAt: config.admissionStartsAt,
        admissionEndsAt: config.admissionEndsAt,
        seats: materializeSeats(config),
      });
      const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const publication = await tx.publication.create({
        data: { eventId, snapshot, snapshotHash },
        select: publicationSelect,
      });
      const envelope = message('catalog', 'SaleProvisionRequested.v1', eventId, 1, snapshot);
      await tx.outbox.create({ data: { id: envelope.eventId, envelope } });
      await tx.auditEntry.create({
        data: {
          organizationId,
          actorSubject: actor.subject,
          action: 'publication.requested',
          targetId: eventId,
          details: { version: 1 },
        },
      });
      return publication;
    });
  }
}
