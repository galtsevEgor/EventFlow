CREATE TABLE "DraftDocument" (
  "eventId" UUID NOT NULL,
  "epoch" UUID NOT NULL,
  "state" BYTEA NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DraftDocument_pkey" PRIMARY KEY ("eventId"),
  CONSTRAINT "DraftDocument_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EventDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
