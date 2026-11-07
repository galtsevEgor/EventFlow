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
      const seats = materializeSeats(config);
      const seatIds = new Set(seats.map((seat) => seat.seatId));
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
        seats,
        ...(config.layout.map
          ? {
              seatMap: {
                ...config.layout.map,
                seats: config.layout.map.seats.filter((position) => seatIds.has(position.seatId)),
              },
            }
          : {}),
      });
      const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const { seatMap, ...fields } = snapshot;
      const envelope = message(
        'catalog',
        'SaleProvisionRequested.v1',
        eventId,
        1,
        seatMap ? { ...fields, seatMap } : fields,
      );
      const publication = await tx.publication.create({
        data: { eventId, snapshot, snapshotHash, requestId: envelope.eventId },
        select: publicationSelect,
      });
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
  async retry(
    actor: UserIdentity,
    organizationId: string,
    eventId: string,
    expectedAttempt: number,
    idempotencyKey: string,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await requireMembership(tx, actor, organizationId, ['OWNER', 'MANAGER']);
      const event = await tx.eventDraft.findFirst({
        where: { id: eventId, organizationId },
        include: { publication: true },
      });
      if (!event) throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`publication-retry:${idempotencyKey}`}, 0))`;
      const retry = await tx.publicationRetry.findUnique({ where: { idempotencyKey } });
      if (retry) {
        if (retry.eventId !== eventId || retry.attempt !== expectedAttempt + 1)
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Ключ повтора уже использован с другим запросом.',
          );
        return tx.publication.findUniqueOrThrow({ where: { eventId }, select: publicationSelect });
      }
      const publication = event.publication;
      if (publication?.state !== 'FAILED' || publication.attempt !== expectedAttempt)
        throw new ApiError(
          409,
          'PUBLICATION_CHANGED',
          'Состояние публикации изменилось. Обновите страницу.',
        );
      const snapshot = provisionSchema.parse(publication.snapshot);
      const { seatMap, ...fields } = snapshot;
      const envelope = message(
        'catalog',
        'SaleProvisionRequested.v1',
        eventId,
        publication.version,
        seatMap ? { ...fields, seatMap } : fields,
      );
      await tx.publicationRetry.create({
        data: { eventId, idempotencyKey, attempt: expectedAttempt + 1 },
      });
      const updated = await tx.publication.update({
        where: { eventId },
        data: {
          state: 'PROVISIONING',
          attempt: { increment: 1 },
          requestId: envelope.eventId,
          failureCode: null,
        },
        select: publicationSelect,
      });
      await tx.outbox.create({ data: { id: envelope.eventId, envelope } });
      await tx.auditEntry.create({
        data: {
          organizationId,
          actorSubject: actor.subject,
          action: 'publication.retried',
          targetId: eventId,
          details: { attempt: updated.attempt },
        },
      });
      return updated;
    });
  }
}
