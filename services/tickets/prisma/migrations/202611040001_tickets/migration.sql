CREATE TABLE "Ticket" (
  "id" UUID PRIMARY KEY,
  "orderId" UUID NOT NULL,
  "seatId" VARCHAR(20) NOT NULL,
  "saleId" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "buyerSubject" VARCHAR(255) NOT NULL,
  "row" INTEGER NOT NULL CHECK ("row" > 0),
  "number" INTEGER NOT NULL CHECK ("number" > 0),
  "categoryName" VARCHAR(60) NOT NULL,
  "qrHash" CHAR(64) NOT NULL,
  "qrKeyId" VARCHAR(32) NOT NULL,
  "qrEncrypted" BYTEA NOT NULL,
  "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "Ticket_orderId_seatId_key" ON "Ticket" ("orderId", "seatId");
CREATE UNIQUE INDEX "Ticket_qrHash_key" ON "Ticket" ("qrHash");

CREATE TABLE "Inbox" (
  "eventId" UUID PRIMARY KEY,
  "seenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
