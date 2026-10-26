CREATE TABLE "OfflineSession" (
  "id" UUID PRIMARY KEY,
  "deviceId" UUID NOT NULL,
  "actorSubject" VARCHAR(255) NOT NULL,
  "organizationId" UUID NOT NULL,
  "eventId" UUID NOT NULL,
  "issuedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "hashes" TEXT[] NOT NULL,
  CONSTRAINT "OfflineSession_expiry" CHECK ("expiresAt" > "issuedAt")
);
ALTER TABLE "CheckIn" ADD COLUMN "offlineSessionId" UUID REFERENCES "OfflineSession"("id"),
  ADD COLUMN "capturedAt" TIMESTAMPTZ(3),
  ADD COLUMN "offlineReason" VARCHAR(24);
