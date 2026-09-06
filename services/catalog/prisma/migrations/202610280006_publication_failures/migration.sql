ALTER TABLE "Publication" DROP CONSTRAINT "Publication_state_check",
 ADD CONSTRAINT "Publication_state_check" CHECK ("state" IN ('PROVISIONING', 'PUBLISHED', 'FAILED')),
 ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1 CHECK ("attempt" > 0),
 ADD COLUMN "requestId" UUID,
 ADD COLUMN "failureCode" VARCHAR(32) CHECK ("failureCode" IN ('SNAPSHOT_CONFLICT', 'INVALID_SNAPSHOT'));
UPDATE "Publication" p SET "requestId" = (
 SELECT o."id" FROM "Outbox" o WHERE o."envelope"->>'aggregateId' = p."eventId"::text
 AND o."envelope"->>'eventType' = 'SaleProvisionRequested.v1' ORDER BY o."availableAt" LIMIT 1);
CREATE TABLE "PublicationRetry" (
 "idempotencyKey" UUID PRIMARY KEY, "eventId" UUID NOT NULL REFERENCES "Publication"("eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
 "attempt" INTEGER NOT NULL CHECK ("attempt" > 1));
CREATE UNIQUE INDEX "PublicationRetry_eventId_attempt_key" ON "PublicationRetry"("eventId", "attempt");
