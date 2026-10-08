ALTER TABLE "PaymentAttempt" ADD COLUMN "recoveryKey" UUID;
ALTER TABLE "RefundOperation" ADD COLUMN "recoveryKey" UUID;
ALTER TABLE "OperatorAction" ADD COLUMN "expectedVersion" VARCHAR(64);
ALTER TABLE "OperatorAction" ADD COLUMN "actorType" VARCHAR(12);
ALTER TABLE "OperatorAction" ADD COLUMN "traceparent" VARCHAR(55);
