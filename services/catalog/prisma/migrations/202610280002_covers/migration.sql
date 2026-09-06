CREATE TABLE "CoverAsset" (
  "id" UUID NOT NULL,
  "eventId" UUID NOT NULL,
  "objectKey" VARCHAR(250) NOT NULL,
  "width" INTEGER NOT NULL CHECK ("width" > 0 AND "width" <= 1600),
  "height" INTEGER NOT NULL CHECK ("height" > 0 AND "height" <= 1600),
  "bytes" INTEGER NOT NULL CHECK ("bytes" > 0 AND "bytes" <= 5242880),
  "isPublic" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoverAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CoverAsset_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EventDraft"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "CoverAsset_objectKey_key" ON "CoverAsset"("objectKey");
CREATE INDEX "CoverAsset_eventId_idx" ON "CoverAsset"("eventId");
ALTER TABLE "EventDraft" ADD COLUMN "coverId" UUID;
ALTER TABLE "EventDraft" ADD CONSTRAINT "EventDraft_coverId_fkey" FOREIGN KEY ("coverId") REFERENCES "CoverAsset"("id") ON DELETE SET NULL;
