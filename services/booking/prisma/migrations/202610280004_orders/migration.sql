CREATE TYPE "OrderState" AS ENUM ('HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "SeatState" AS ENUM ('AVAILABLE', 'HELD', 'SOLD');
CREATE TABLE "Order" (
  "id" UUID PRIMARY KEY, "saleId" UUID NOT NULL REFERENCES "Sale"("id"),
  "buyerSubject" VARCHAR(255) NOT NULL CHECK (length("buyerSubject") > 0),
  "organizationId" UUID NOT NULL, "title" VARCHAR(160) NOT NULL,
  "currency" CHAR(3) NOT NULL CHECK ("currency" = 'EUR'),
  "totalMinor" INTEGER NOT NULL CHECK ("totalMinor" BETWEEN 1 AND 600000000),
  "state" "OrderState" NOT NULL DEFAULT 'HELD',
  "createdAt" TIMESTAMPTZ(3) NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes'),
  UNIQUE ("id", "saleId"), UNIQUE ("id", "saleId", "buyerSubject")
);
CREATE INDEX "Order_buyerSubject_createdAt_idx" ON "Order"("buyerSubject", "createdAt");
CREATE INDEX "Order_state_expiresAt_idx" ON "Order"("state", "expiresAt");
CREATE TABLE "OrderItem" (
  "orderId" UUID NOT NULL, "saleId" UUID NOT NULL, "seatId" VARCHAR(20) NOT NULL,
  "row" INTEGER NOT NULL CHECK ("row" BETWEEN 1 AND 50),
  "number" INTEGER NOT NULL CHECK ("number" BETWEEN 1 AND 50),
  "categoryName" VARCHAR(60) NOT NULL,
  "priceMinor" INTEGER NOT NULL CHECK ("priceMinor" BETWEEN 1 AND 100000000),
  PRIMARY KEY ("orderId", "seatId"),
  FOREIGN KEY ("orderId", "saleId") REFERENCES "Order"("id", "saleId"),
  FOREIGN KEY ("saleId", "seatId") REFERENCES "SeatInventory"("saleId", "seatId")
);
ALTER TABLE "SeatInventory"
  ADD COLUMN "state" "SeatState" NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN "currentOrderId" UUID,
  ADD COLUMN "expiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0 CHECK ("version" >= 0),
  ADD FOREIGN KEY ("currentOrderId", "saleId") REFERENCES "Order"("id", "saleId"),
  ADD CHECK (
    ("state" = 'AVAILABLE' AND "currentOrderId" IS NULL AND "expiresAt" IS NULL) OR
    ("state" = 'HELD' AND "currentOrderId" IS NOT NULL AND "expiresAt" IS NOT NULL) OR
    ("state" = 'SOLD' AND "currentOrderId" IS NOT NULL AND "expiresAt" IS NULL)
  );
CREATE TABLE "BuyerSaleSlot" (
  "buyerSubject" VARCHAR(255) NOT NULL, "saleId" UUID NOT NULL REFERENCES "Sale"("id"),
  "currentOrderId" UUID,
  PRIMARY KEY ("buyerSubject", "saleId"),
  FOREIGN KEY ("currentOrderId", "saleId", "buyerSubject")
    REFERENCES "Order"("id", "saleId", "buyerSubject")
);
CREATE TABLE "ReservationRequest" (
  "buyerSubject" VARCHAR(255) NOT NULL, "key" UUID NOT NULL, "payloadHash" CHAR(64) NOT NULL,
  "status" INTEGER NOT NULL CHECK ("status" IN (201, 404, 409, 422)),
  "response" JSONB NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("buyerSubject", "key")
);
