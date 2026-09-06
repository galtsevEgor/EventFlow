ALTER TABLE "Sale" ADD CONSTRAINT "Sale_admission_includes_start" CHECK ("admissionEndsAt" >= "startsAt");
