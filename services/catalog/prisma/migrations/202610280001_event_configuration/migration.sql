ALTER TABLE "EventDraft"
  ADD COLUMN "configuration" JSONB,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "EventDraft_revision_nonnegative" CHECK ("revision" >= 0);
