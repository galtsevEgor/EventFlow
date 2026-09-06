ALTER TABLE "PaymentResult" ADD COLUMN "refundState" VARCHAR(20)
  CHECK ("refundState" IN ('SUCCEEDED', 'REQUIRES_REVIEW'));
