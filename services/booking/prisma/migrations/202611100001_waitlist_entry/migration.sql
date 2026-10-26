ALTER TABLE "Order" ADD COLUMN "waitlistEntryId" UUID;
CREATE UNIQUE INDEX "Order_waitlistEntryId_key" ON "Order"("waitlistEntryId");
