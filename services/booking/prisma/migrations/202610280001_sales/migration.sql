CREATE TABLE "Sale" (
 "id" UUID PRIMARY KEY, "organizationId" UUID NOT NULL, "version" INTEGER NOT NULL CHECK ("version" = 1),
 "snapshotHash" CHAR(64) NOT NULL, "title" VARCHAR(160) NOT NULL, "currency" CHAR(3) NOT NULL CHECK ("currency" = 'EUR'),
 "timeZone" VARCHAR(100) NOT NULL, "startsAt" TIMESTAMPTZ NOT NULL, "endsAt" TIMESTAMPTZ NOT NULL,
 "salesStartsAt" TIMESTAMPTZ NOT NULL, "salesEndsAt" TIMESTAMPTZ NOT NULL,
 "admissionStartsAt" TIMESTAMPTZ NOT NULL, "admissionEndsAt" TIMESTAMPTZ NOT NULL,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("salesStartsAt" < "salesEndsAt" AND "salesEndsAt" <= "startsAt" AND "startsAt" < "endsAt"),
 CHECK ("admissionStartsAt" < "admissionEndsAt" AND "admissionStartsAt" <= "startsAt" AND "admissionEndsAt" <= "endsAt"));
CREATE TABLE "SeatInventory" (
 "saleId" UUID NOT NULL REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "seatId" VARCHAR(20) NOT NULL, "row" INTEGER NOT NULL CHECK ("row" BETWEEN 1 AND 50),
 "number" INTEGER NOT NULL CHECK ("number" BETWEEN 1 AND 50),
 "categoryId" VARCHAR(32) NOT NULL, "categoryName" VARCHAR(60) NOT NULL,
 "priceMinor" INTEGER NOT NULL CHECK ("priceMinor" BETWEEN 1 AND 100000000),
 PRIMARY KEY ("saleId", "seatId"));
CREATE UNIQUE INDEX "SeatInventory_saleId_row_number_key" ON "SeatInventory"("saleId", "row", "number");
CREATE TABLE "Outbox" (
 "id" UUID PRIMARY KEY, "envelope" JSONB NOT NULL, "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "sentAt" TIMESTAMPTZ, "lease" UUID, "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0));
CREATE INDEX "Outbox_sentAt_availableAt_idx" ON "Outbox"("sentAt", "availableAt");
CREATE TABLE "Inbox" ("eventId" UUID PRIMARY KEY, "processedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
