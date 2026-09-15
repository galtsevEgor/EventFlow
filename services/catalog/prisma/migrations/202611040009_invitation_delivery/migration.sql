ALTER TABLE "Invitation" ADD COLUMN "deliveryToken" BYTEA;

CREATE TABLE "DeliveryJob" (
  "id" UUID PRIMARY KEY,
  "state" VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING', 'SENT', 'SKIPPED', 'DEAD')),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "nextRunAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease" UUID
);
CREATE INDEX "DeliveryJob_state_nextRunAt_idx" ON "DeliveryJob" ("state", "nextRunAt");
CREATE TABLE "DeliveryRetry" (
  "requestId" UUID PRIMARY KEY,
  "jobId" UUID NOT NULL,
  "actorSubject" VARCHAR(255) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
