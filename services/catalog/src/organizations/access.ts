import { ApiError, type UserIdentity } from '@eventflow/service-runtime';
import type { Prisma, OrganizationRole } from '../generated/client';

export async function requireMembership(
  tx: Prisma.TransactionClient,
  actor: UserIdentity,
  organizationId: string,
  roles?: OrganizationRole[],
) {
  const membership = await tx.membership.findUnique({
    where: { organizationId_userSubject: { organizationId, userSubject: actor.subject } },
  });
  if (!membership) throw new ApiError(404, 'NOT_FOUND', 'Организация не найдена.');
  if (roles && !roles.includes(membership.role))
    throw new ApiError(403, 'FORBIDDEN', 'Недостаточно прав для этого действия.');
  return membership;
}

export async function lockOrganization(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId}::uuid FOR UPDATE`;
}
