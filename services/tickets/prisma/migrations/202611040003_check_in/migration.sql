ALTER TABLE "Ticket" ADD COLUMN "usedAt" TIMESTAMPTZ(3);

CREATE TABLE "CheckIn" (
  "requestId" UUID PRIMARY KEY,
  "requestHash" CHAR(64) NOT NULL,
  "actorSubject" VARCHAR(255) NOT NULL,
  "organizationId" UUID NOT NULL,
  "eventId" UUID NOT NULL,
  "ticketId" UUID,
  "result" VARCHAR(16) NOT NULL CHECK ("result" IN ('ADMITTED', 'ALREADY_USED', 'WRONG_EVENT', 'INVALID_TICKET', 'WINDOW_CLOSED')),
  "admittedAt" TIMESTAMPTZ(3),
  "checkedAt" TIMESTAMPTZ(3) NOT NULL
);

CREATE INDEX "CheckIn_eventId_checkedAt_idx" ON "CheckIn" ("eventId", "checkedAt");
