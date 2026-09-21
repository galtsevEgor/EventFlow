CREATE TABLE "RefundGate" (
  "orderId" UUID PRIMARY KEY, "operationId" UUID NOT NULL UNIQUE, "saleId" UUID NOT NULL,
  "organizationId" UUID NOT NULL, state VARCHAR(10) NOT NULL CHECK (state IN ('LOCKED','REJECTED','REVOKED')),
  "payloadHash" CHAR(64), code VARCHAR(60), "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Outbox" (
  id UUID PRIMARY KEY, envelope JSONB NOT NULL, "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMPTZ, lease UUID, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "Outbox_sentAt_availableAt_idx" ON "Outbox"("sentAt", "availableAt");
CREATE FUNCTION prevent_refund_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."usedAt" IS NOT NULL AND OLD."usedAt" IS NULL AND EXISTS (
    SELECT 1 FROM "RefundGate" WHERE "orderId" = NEW."orderId" AND state IN ('LOCKED','REVOKED')
  ) THEN
    RAISE EXCEPTION 'Admission is blocked by refund' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER prevent_refund_admission BEFORE UPDATE OF "usedAt" ON "Ticket"
FOR EACH ROW EXECUTE FUNCTION prevent_refund_admission();
