CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'MANAGER', 'STAFF');

CREATE TABLE "Organization" (
  "id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "createdBy" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Membership" (
  "organizationId" UUID NOT NULL,
  "userSubject" VARCHAR(128) NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "role" "OrganizationRole" NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Membership_pkey" PRIMARY KEY ("organizationId", "userSubject"),
  CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AuditEntry" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "actorSubject" VARCHAR(128) NOT NULL,
  "action" VARCHAR(64) NOT NULL,
  "targetId" VARCHAR(128) NOT NULL,
  "details" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuditEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Organization_createdBy_idx" ON "Organization"("createdBy");
CREATE INDEX "Membership_userSubject_idx" ON "Membership"("userSubject");
CREATE INDEX "AuditEntry_organizationId_createdAt_idx" ON "AuditEntry"("organizationId", "createdAt");
