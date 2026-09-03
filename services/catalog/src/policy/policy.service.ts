import { Database } from '../database';

export type PolicyRequest = {
  actorSubject: string;
  organizationId: string;
  eventId?: string | undefined;
  action: 'events:read' | 'events:write' | 'members:manage' | 'check-in';
};
export class PolicyService {
  constructor(private readonly db: Database) {}
  async check(input: PolicyRequest) {
    const { organizationId, actorSubject, eventId, action } = input;
    const member = await this.db.membership.findUnique({
      where: { organizationId_userSubject: { organizationId, userSubject: actorSubject } },
    });
    if (!member) return { allowed: false };
    if (
      eventId &&
      !(await this.db.eventDraft.findFirst({ where: { id: eventId, organizationId } }))
    )
      return { allowed: false };
    if (action === 'members:manage') return { allowed: member.role === 'OWNER' };
    if (action === 'check-in' && !eventId) return { allowed: false };
    if (member.role === 'OWNER' || member.role === 'MANAGER') return { allowed: true };
    if (action === 'events:write' || !eventId) return { allowed: false };
    return {
      allowed: !!(await this.db.staffAssignment.findUnique({
        where: {
          organizationId_userSubject_eventId: {
            organizationId,
            userSubject: actorSubject,
            eventId,
          },
        },
      })),
    };
  }
}
