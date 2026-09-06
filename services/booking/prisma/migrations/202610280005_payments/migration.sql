ALTER TABLE "Order" ADD COLUMN "confirmedPaymentId" VARCHAR(255) UNIQUE,
  ADD COLUMN "confirmedAt" TIMESTAMPTZ(3);
CREATE TABLE "PaymentAuthorization" (
  "attemptId" UUID PRIMARY KEY, "orderId" UUID NOT NULL UNIQUE REFERENCES "Order"("id"),
  "provider" VARCHAR(12) NOT NULL CHECK ("provider" IN ('fake', 'stripe')),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "PaymentResult" (
  "providerPaymentId" VARCHAR(255) PRIMARY KEY, "attemptId" UUID NOT NULL, "orderId" UUID NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "disposition" VARCHAR(20) NOT NULL CHECK ("disposition" IN ('CONFIRMED', 'REFUND', 'REVIEW')),
  "operationId" UUID UNIQUE, "reason" VARCHAR(60),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("disposition" = 'REFUND') = ("operationId" IS NOT NULL))
);
