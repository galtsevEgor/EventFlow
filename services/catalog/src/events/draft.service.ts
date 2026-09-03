import { ApiError, type UserIdentity } from '@eventflow/service-runtime';
import { Database } from '../database';
import { lockOrganization, requireMembership } from '../organizations/access';

export class DraftService {
  constructor(private readonly db: Database) {}
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
        ? await tx.eventDraft.update({ where: { id }, data })
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
