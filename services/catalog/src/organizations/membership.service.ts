import { ApiError, type UserIdentity } from '@eventflow/service-runtime';
import type { OrganizationRole } from '../generated/client';
import { Database } from '../database';
import { lockOrganization, requireMembership } from './access';

export class MembershipService {
  constructor(private readonly db: Database) {}
  async list(actor: UserIdentity, organizationId: string) {
    await requireMembership(this.db, actor, organizationId, ['OWNER']);
    return {
      members: await this.db.membership.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
        take: 200,
        select: {
          userSubject: true,
          email: true,
          role: true,
          assignments: { select: { eventId: true } },
        },
      }),
    };
  }
  async changeRole(
    actor: UserIdentity,
    organizationId: string,
    userSubject: string,
    role: OrganizationRole | null,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await requireMembership(tx, actor, organizationId, ['OWNER']);
      const where = { organizationId_userSubject: { organizationId, userSubject } };
      const target = await tx.membership.findUnique({ where });
      if (!target) throw new ApiError(404, 'NOT_FOUND', 'Участник не найден.');
      if (
        target.role === 'OWNER' &&
        role !== 'OWNER' &&
        (await tx.membership.count({ where: { organizationId, role: 'OWNER' } })) <= 1
      )
        throw new ApiError(
          409,
          'LAST_OWNER',
          'В организации должен остаться хотя бы один владелец.',
        );
      if (role === null) await tx.membership.delete({ where });
      else {
        await tx.membership.update({ where, data: { role } });
        if (role !== 'STAFF')
          await tx.staffAssignment.deleteMany({ where: { organizationId, userSubject } });
      }
      await tx.auditEntry.create({
        data: {
          organizationId,
          actorSubject: actor.subject,
          action: role ? 'membership.role_changed' : 'membership.removed',
          targetId: userSubject,
          details: { previousRole: target.role, role },
        },
      });
      return { userSubject, role };
    });
  }
  async assignEvent(
    actor: UserIdentity,
    organizationId: string,
    userSubject: string,
    eventId: string,
    assigned: boolean,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await requireMembership(tx, actor, organizationId, ['OWNER']);
      const member = await tx.membership.findUnique({
        where: { organizationId_userSubject: { organizationId, userSubject } },
      });
      const event = await tx.eventDraft.findFirst({ where: { organizationId, id: eventId } });
      if (!member || !event)
        throw new ApiError(404, 'NOT_FOUND', 'Участник или мероприятие не найдено.');
      if (member.role !== 'STAFF')
        throw new ApiError(
          409,
          'NOT_CHECK_IN_STAFF',
          'Назначение требуется только сотруднику входа.',
        );
      const key = { organizationId, userSubject, eventId };
      if (assigned)
        await tx.staffAssignment.upsert({
          where: { organizationId_userSubject_eventId: key },
          create: key,
          update: {},
        });
      else await tx.staffAssignment.deleteMany({ where: key });
      await tx.auditEntry.create({
        data: {
          organizationId,
          actorSubject: actor.subject,
          action: assigned ? 'staff.assigned' : 'staff.unassigned',
          targetId: userSubject,
          details: { eventId },
        },
      });
      return { assigned };
    });
  }
}
