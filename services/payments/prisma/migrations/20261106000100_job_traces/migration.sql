ALTER TABLE "PaymentAttempt" ADD COLUMN traceparent varchar(55);
ALTER TABLE "RefundOperation" ADD COLUMN traceparent varchar(55);
ALTER TABLE "ProviderWebhook" ADD COLUMN traceparent varchar(55);
