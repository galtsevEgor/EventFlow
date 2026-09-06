CREATE TYPE "PaymentState" AS ENUM ('CREATED', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'CANCELLED', 'NEEDS_RECONCILIATION', 'REQUIRES_REVIEW');
CREATE TYPE "RefundState" AS ENUM ('PENDING', 'UNKNOWN', 'SUCCEEDED', 'REQUIRES_REVIEW');
CREATE TABLE "PaymentAttempt" (
  "id" UUID PRIMARY KEY, "orderId" UUID NOT NULL UNIQUE,
  "buyerSubject" VARCHAR(255) NOT NULL CHECK (length("buyerSubject") > 0),
  "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" BETWEEN 1 AND 600000000),
  "currency" CHAR(3) NOT NULL CHECK ("currency" = 'EUR'),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "provider" VARCHAR(12) NOT NULL CHECK ("provider" IN ('fake', 'stripe')),
  "providerPaymentId" VARCHAR(255) UNIQUE,
  "state" "PaymentState" NOT NULL DEFAULT 'CREATED',
  "bookingState" VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK ("bookingState" IN ('PENDING', 'CONFIRMED', 'REFUND_PENDING', 'REFUNDED', 'REQUIRES_REVIEW')),
  "reviewCode" VARCHAR(60), "cancelRequested" BOOLEAN NOT NULL DEFAULT FALSE,
  "authorized" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "nextRunAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease" UUID, "leaseUntil" TIMESTAMPTZ(3),
  "failures" INTEGER NOT NULL DEFAULT 0 CHECK ("failures" >= 0),
  "successPublished" BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (("lease" IS NULL) = ("leaseUntil" IS NULL)),
  CHECK (NOT "successPublished" OR "providerPaymentId" IS NOT NULL),
  UNIQUE ("id", "orderId", "buyerSubject")
);
CREATE INDEX "PaymentAttempt_nextRunAt_leaseUntil_idx" ON "PaymentAttempt"("nextRunAt", "leaseUntil");
CREATE TABLE "PaymentRequest" (
  "buyerSubject" VARCHAR(255) NOT NULL, "key" UUID NOT NULL,
  "orderId" UUID NOT NULL, "attemptId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("buyerSubject", "key"),
  FOREIGN KEY ("attemptId", "orderId", "buyerSubject") REFERENCES "PaymentAttempt"("id", "orderId", "buyerSubject")
);
CREATE TABLE "RefundOperation" (
  "id" UUID PRIMARY KEY, "attemptId" UUID NOT NULL UNIQUE REFERENCES "PaymentAttempt"("id"),
  "orderId" UUID NOT NULL, "providerPaymentId" VARCHAR(255) NOT NULL,
  "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" BETWEEN 1 AND 600000000),
  "currency" CHAR(3) NOT NULL CHECK ("currency" = 'EUR'), "reason" VARCHAR(60) NOT NULL,
  "state" "RefundState" NOT NULL DEFAULT 'PENDING',
  "providerRefundId" VARCHAR(255) UNIQUE, "reviewCode" VARCHAR(60),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextRunAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease" UUID, "leaseUntil" TIMESTAMPTZ(3),
  "failures" INTEGER NOT NULL DEFAULT 0 CHECK ("failures" >= 0),
  CHECK (("lease" IS NULL) = ("leaseUntil" IS NULL))
);
CREATE TABLE "ProviderWebhook" (
  "eventId" VARCHAR(255) PRIMARY KEY, "objectId" VARCHAR(255) NOT NULL,
  "type" VARCHAR(100) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(3), "reviewCode" VARCHAR(60)
);
CREATE TABLE "ClosedOrder" (
  "orderId" UUID PRIMARY KEY, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "OperatorAction" (
  "key" UUID PRIMARY KEY, "actor" VARCHAR(255) NOT NULL, "targetId" UUID NOT NULL,
  "kind" VARCHAR(20) NOT NULL, "reason" VARCHAR(240) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "FakePayment" (
  "id" VARCHAR(255) PRIMARY KEY, "attemptId" UUID NOT NULL UNIQUE, "orderId" UUID NOT NULL,
  "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0), "currency" CHAR(3) NOT NULL,
  "status" VARCHAR(30) NOT NULL CHECK ("status" IN ('requires_action', 'processing', 'succeeded', 'cancelled'))
);
CREATE TABLE "FakeRefund" (
  "id" VARCHAR(255) PRIMARY KEY, "operationId" UUID NOT NULL UNIQUE,
  "paymentId" VARCHAR(255) NOT NULL UNIQUE REFERENCES "FakePayment"("id"),
  "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0),
  "status" VARCHAR(30) NOT NULL CHECK ("status" IN ('pending', 'succeeded', 'failed'))
);
CREATE TABLE "Outbox" (
  "id" UUID PRIMARY KEY, "envelope" JSONB NOT NULL,
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "sentAt" TIMESTAMPTZ,
  "lease" UUID, "attempts" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "Outbox_sentAt_availableAt_idx" ON "Outbox"("sentAt", "availableAt");
CREATE TABLE "Inbox" (
  "eventId" UUID PRIMARY KEY, "processedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
