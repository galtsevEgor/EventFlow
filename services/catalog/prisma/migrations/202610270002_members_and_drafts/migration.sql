CREATE TABLE "Invitation" (
  "id" UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "email" VARCHAR(254) NOT NULL,
  "role" "OrganizationRole" NOT NULL CHECK ("role" IN ('MANAGER', 'STAFF')),
  "tokenHash" CHAR(64) NOT NULL UNIQUE,
  "createdBy" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "acceptedAt" TIMESTAMPTZ,
  "revokedAt" TIMESTAMPTZ
);
CREATE INDEX "Invitation_organizationId_email_idx" ON "Invitation"("organizationId", "email");

CREATE TABLE "EventDraft" (
  "id" UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "title" VARCHAR(160) NOT NULL,
  "description" VARCHAR(5000) NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventDraft_organizationId_id_key" UNIQUE ("organizationId", "id")
);

CREATE TABLE "StaffAssignment" (
  "organizationId" UUID NOT NULL,
  "userSubject" VARCHAR(128) NOT NULL,
  "eventId" UUID NOT NULL,
  PRIMARY KEY ("organizationId", "userSubject", "eventId"),
  FOREIGN KEY ("organizationId", "userSubject") REFERENCES "Membership"("organizationId", "userSubject") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("organizationId", "eventId") REFERENCES "EventDraft"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
