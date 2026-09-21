ALTER TABLE "SalesOrder" DROP CONSTRAINT "SalesOrder_version_check",
  DROP CONSTRAINT "SalesOrder_state_check", DROP CONSTRAINT "SalesOrder_check", DROP CONSTRAINT "SalesOrder_check1";
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_state_version_check" CHECK (
  (state = 'HELD' AND version = 1) OR
  (state IN ('CONFIRMED','EXPIRED','CANCELLED') AND version = 2) OR
  (state = 'REFUNDED' AND version = 3)
), ADD CONSTRAINT "SalesOrder_confirmation_check" CHECK (
  (state IN ('CONFIRMED','REFUNDED')) = ("confirmedAt" IS NOT NULL)
);
