CREATE INDEX "PaymentAttempt_open_createdAt_idx" ON "PaymentAttempt" ("createdAt")
WHERE "state" IN ('PROCESSING', 'NEEDS_RECONCILIATION', 'REQUIRES_REVIEW');
