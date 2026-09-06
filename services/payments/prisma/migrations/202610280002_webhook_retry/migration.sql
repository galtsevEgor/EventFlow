ALTER TABLE "ProviderWebhook"
  ADD COLUMN "nextRunAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "failures" INTEGER NOT NULL DEFAULT 0 CHECK ("failures" >= 0);
CREATE INDEX "ProviderWebhook_pending_idx" ON "ProviderWebhook"("nextRunAt") WHERE "processedAt" IS NULL;
