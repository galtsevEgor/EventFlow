import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError, type SecretBox, type UserIdentity } from '@eventflow/service-runtime';
import { Database } from '../database';
import { lockOrganization, requireMembership } from './access';
import { currentTraceparent } from '@eventflow/telemetry';

const INVITATION_LIST_LIMIT = 100;
const INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export class InvitationService {
  constructor(
    private readonly db: Database,
    private readonly deliveryBox: SecretBox,
  ) {}
  async list(actor: UserIdentity, organizationId: string) {
    await requireMembership(this.db, actor, organizationId, ['OWNER']);
    return {
      invitations: await this.db.invitation.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: INVITATION_LIST_LIMIT,
        select: {
          id: true,
          email: true,
          role: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
        },
      }),
    };
  }
  async create(
    actor: UserIdentity,
    organizationId: string,
    email: string,
    role: 'MANAGER' | 'STAFF',
  ) {
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await requireMembership(tx, actor, organizationId, ['OWNER']);
      if ((await tx.membership.count({ where: { organizationId } })) >= 200)
        throw new ApiError(409, 'MEMBER_LIMIT', 'Достигнут лимит участников демо.');
      if (await tx.membership.findFirst({ where: { organizationId, email } }))
        throw new ApiError(409, 'ALREADY_MEMBER', 'Пользователь уже состоит в организации.');
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const now = clock?.now;
      if (!now) throw new Error('Database clock unavailable');
      if (
        await tx.invitation.findFirst({
          where: {
            organizationId,
            email,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
        })
      )
        throw new ApiError(409, 'INVITATION_EXISTS', 'Активное приглашение уже существует.');
      const token = randomBytes(32).toString('base64url');
      const id = randomUUID();
      const invitation = await tx.invitation.create({
        data: {
          id,
          deliveryToken: this.deliveryBox.seal(token, id),
          organizationId,
          email,
          role,
          tokenHash: digest(token),
          createdBy: actor.subject,
          expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS),
        },
      });
      await tx.deliveryJob.create({ data: { id, traceparent: currentTraceparent() ?? null } });
      await tx.auditEntry.create({
        data: {
          organizationId,
          actorSubject: actor.subject,
          action: 'invitation.created',
          targetId: invitation.id,
          details: { role },
        },
      });
      return { id: invitation.id, token, expiresAt: invitation.expiresAt };
    });
  }
  async accept(actor: UserIdentity, token: string) {
    if (!actor.emailVerified)
      throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Для принятия приглашения подтвердите email.');
    const original = await this.db.invitation.findUnique({ where: { tokenHash: digest(token) } });
    if (!original) throw new ApiError(404, 'INVITATION_INVALID', 'Приглашение не найдено.');
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, original.organizationId);
      const invitation = await tx.invitation.findUniqueOrThrow({ where: { id: original.id } });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const now = clock?.now;
      if (!now) throw new Error('Database clock unavailable');
      if (invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now)
        throw new ApiError(
          409,
          'INVITATION_EXPIRED',
          'Приглашение уже использовано, отозвано или истекло.',
        );
      if (invitation.email !== actor.email)
        throw new ApiError(
          403,
          'INVITATION_EMAIL_MISMATCH',
          'Войдите с email, на который выдано приглашение.',
        );
      const organizationId = invitation.organizationId;
      if (
        await tx.membership.findUnique({
          where: { organizationId_userSubject: { organizationId, userSubject: actor.subject } },
        })
      )
        throw new ApiError(409, 'ALREADY_MEMBER', 'Вы уже состоите в организации.');
      if ((await tx.membership.count({ where: { organizationId } })) >= 200)
        throw new ApiError(409, 'MEMBER_LIMIT', 'Достигнут лимит участников демо.');
      await tx.membership.create({
        data: {
          organizationId,
          userSubject: actor.subject,
          email: actor.email,
          role: invitation.role,
        },
      });
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: now, deliveryToken: null },
      });
      await tx.auditEntry.create({
        data: {
          organizationId,
          actorSubject: actor.subject,
          action: 'invitation.accepted',
          targetId: invitation.id,
          details: { role: invitation.role },
        },
      });
      return { organizationId, role: invitation.role };
    });
  }
  async revoke(actor: UserIdentity, organizationId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      await lockOrganization(tx, organizationId);
      await requireMembership(tx, actor, organizationId, ['OWNER']);
      const invitation = await tx.invitation.findFirst({ where: { id, organizationId } });
      if (!invitation) throw new ApiError(404, 'NOT_FOUND', 'Приглашение не найдено.');
      if (invitation.acceptedAt)
        throw new ApiError(
          409,
          'INVITATION_ACCEPTED',
          'Участник уже принял приглашение. Управляйте его ролью.',
        );
      await tx.invitation.update({
        where: { id },
        data: { revokedAt: new Date(), deliveryToken: null },
      });
      await tx.auditEntry.create({
        data: {
          organizationId,
          actorSubject: actor.subject,
          action: 'invitation.revoked',
          targetId: id,
          details: {},
        },
      });
      return { revoked: true };
    });
  }
}
