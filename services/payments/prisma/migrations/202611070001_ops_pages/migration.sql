CREATE INDEX "PaymentAttempt_state_createdAt_id_idx" ON "PaymentAttempt" ("state", "createdAt", "id");
CREATE INDEX "PaymentAttempt_bookingState_createdAt_id_idx" ON "PaymentAttempt" ("bookingState", "createdAt", "id");
CREATE INDEX "RefundOperation_state_createdAt_id_idx" ON "RefundOperation" ("state", "createdAt", "id");
CREATE INDEX "ProviderWebhook_reviewCode_createdAt_eventId_idx" ON "ProviderWebhook" ("reviewCode", "createdAt", "eventId");
