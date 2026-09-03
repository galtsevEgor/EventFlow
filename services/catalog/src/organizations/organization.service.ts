import { ApiError, type UserIdentity } from '@eventflow/service-runtime';
import { Database } from '../database';
import { lockOrganization, requireMembership } from './access';

export class OrganizationService {
  constructor(private readonly db: Database) {}

  async create(actor: UserIdentity, name: string) {
    if (!actor.emailVerified)
      throw new ApiError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Подтвердите email перед созданием организации.',
      );
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.subject}, 0))`;
      if ((await tx.organization.count({ where: { createdBy: actor.subject } })) >= 5)
        throw new ApiError(409, 'ORGANIZATION_LIMIT', 'В демо можно создать до пяти организаций.');
      const organization = await tx.organization.create({
        data: {
          name,
          createdBy: actor.subject,
          memberships: {
            create: { userSubject: actor.subject, email: actor.email, role: 'OWNER' },
          },
        },
      });
      await tx.auditEntry.create({
        data: {
          organizationId: organization.id,
          actorSubject: actor.subject,
          action: 'organization.created',
          targetId: organization.id,
          details: {},
        },
      });
      return { id: organization.id, name: organization.name, role: 'OWNER' as const };
    });
  }
  async list(actor: UserIdentity) {
    const memberships = await this.db.membership.findMany({
      where: { userSubject: actor.subject },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return {
      organizations: memberships.map(({ organization, role }) => ({
        id: organization.id,
        name: organization.name,
        role,
      })),
    };
  }
  async get(actor: UserIdentity, id: string) {
    const member = await requireMembership(this.db, actor, id);
    const organization = await this.db.organization.findUniqueOrThrow({ where: { id } });
    return { id, name: organization.name, role: member.role };
  }
  async rename(actor: UserIdentity, id: string, name: string) {
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, id);
      await requireMembership(tx, actor, id, ['OWNER']);
      await tx.organization.update({ where: { id }, data: { name } });
      await tx.auditEntry.create({
        data: {
          organizationId: id,
          actorSubject: actor.subject,
          action: 'organization.renamed',
          targetId: id,
          details: {},
        },
      });
      return { id, name, role: 'OWNER' as const };
    });
  }
  async audit(actor: UserIdentity, id: string) {
    await requireMembership(this.db, actor, id, ['OWNER']);
    return {
      entries: await this.db.auditEntry.findMany({
        where: { organizationId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
    };
  }
}
