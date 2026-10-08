ALTER TABLE "DeliveryJob" ADD COLUMN "recoveryKey" UUID;
ALTER TABLE "DeliveryRetry" ADD COLUMN "reason" VARCHAR(240);
ALTER TABLE "DeliveryRetry" ADD COLUMN "expectedVersion" VARCHAR(64);
ALTER TABLE "DeliveryRetry" ADD COLUMN "actorType" VARCHAR(12);
ALTER TABLE "DeliveryRetry" ADD COLUMN "traceparent" VARCHAR(55);
