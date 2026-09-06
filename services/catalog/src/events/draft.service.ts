import { ApiError, parseInput, type UserIdentity } from '@eventflow/service-runtime';
import { configurationSchema } from './configuration';
import { Database } from '../database';
import { lockOrganization, requireMembership } from '../organizations/access';

export class DraftService {
  constructor(
    private readonly db: Database,
    private readonly maximumPriceMinor = 10_000_000,
  ) {}
  async configure(
    actor: UserIdentity,
    organizationId: string,
    id: string,
    revision: number,
    input: unknown,
  ) {
    const configuration = parseInput(configurationSchema, input);
    if (configuration.categories.some((category) => category.priceMinor > this.maximumPriceMinor))
      throw new ApiError(422, 'PRICE_LIMIT', 'Цена превышает допустимый лимит.', {
        categories: [`Максимум ${this.maximumPriceMinor} евроцентов.`],
      });
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await requireMembership(tx, actor, organizationId, ['OWNER', 'MANAGER']);
      const event = await tx.eventDraft.findFirst({ where: { id, organizationId } });
      if (!event) throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
      if (event.revision !== revision)
        throw new ApiError(
          409,
          'DRAFT_CHANGED',
          'Черновик уже изменён. Обновите страницу и повторите правки.',
        );
      const updated = await tx.eventDraft.update({
        where: { id },
        data: { configuration, revision: { increment: 1 } },
      });
      await tx.auditEntry.create({
        data: {
          organizationId,
          actorSubject: actor.subject,
          action: 'draft.configured',
          targetId: id,
          details: { revision: updated.revision },
        },
      });
      return updated;
    });
  }
  async list(actor: UserIdentity, organizationId: string) {
    const member = await requireMembership(this.db, actor, organizationId);
    return {
      events: await this.db.eventDraft.findMany({
        where: {
          organizationId,
          ...(member.role === 'STAFF'
            ? { assignments: { some: { userSubject: actor.subject } } }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    };
  }
  async get(actor: UserIdentity, organizationId: string, id: string) {
    const member = await requireMembership(this.db, actor, organizationId);
    const event = await this.db.eventDraft.findFirst({
      where: {
        id,
        organizationId,
        ...(member.role === 'STAFF'
          ? { assignments: { some: { userSubject: actor.subject } } }
          : {}),
      },
    });
    if (!event) throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
    return event;
  }
  async save(
    actor: UserIdentity,
    organizationId: string,
    data: { title: string; description: string },
    id?: string,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await requireMembership(tx, actor, organizationId, ['OWNER', 'MANAGER']);
      if (id && !(await tx.eventDraft.findFirst({ where: { id, organizationId } })))
        throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
      const event = id
        ? await tx.eventDraft.update({
            where: { id },
            data: { ...data, revision: { increment: 1 } },
          })
        : await tx.eventDraft.create({ data: { organizationId, ...data } });
      await tx.auditEntry.create({
        data: {
          organizationId,
          actorSubject: actor.subject,
          action: id ? 'draft.updated' : 'draft.created',
          targetId: event.id,
          details: {},
        },
      });
      return event;
    });
  }
}
