CREATE TABLE "SalesOrder" (
  "orderId" UUID PRIMARY KEY, "eventId" UUID NOT NULL, "organizationId" UUID NOT NULL,
  "version" INTEGER NOT NULL CHECK (version IN (1, 2)), "payloadHash" CHAR(64) NOT NULL,
  "state" VARCHAR(10) NOT NULL CHECK (state IN ('HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED')),
  "seatCount" INTEGER NOT NULL CHECK ("seatCount" BETWEEN 1 AND 6),
  "totalMinor" INTEGER NOT NULL CHECK ("totalMinor" > 0), "currency" CHAR(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "confirmedAt" TIMESTAMPTZ(3), "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((state = 'HELD') = (version = 1)),
  CHECK ((state = 'CONFIRMED') = ("confirmedAt" IS NOT NULL))
);
CREATE INDEX "SalesOrder_organizationId_eventId_idx" ON "SalesOrder" ("organizationId", "eventId");
CREATE TABLE "SalesPayment" (
  "attemptId" UUID PRIMARY KEY, "orderId" UUID NOT NULL,
  "providerPaymentId" VARCHAR(255) NOT NULL UNIQUE, "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0),
  "currency" CHAR(3) NOT NULL, "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
  "payloadHash" CHAR(64) NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SalesPayment_orderId_idx" ON "SalesPayment" ("orderId");
CREATE TABLE "SalesRefund" (
  "operationId" UUID PRIMARY KEY, "attemptId" UUID NOT NULL UNIQUE, "orderId" UUID NOT NULL,
  "providerPaymentId" VARCHAR(255) NOT NULL, "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "payloadHash" CHAR(64) NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SalesRefund_orderId_idx" ON "SalesRefund" ("orderId");
