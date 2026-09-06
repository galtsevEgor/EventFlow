ALTER TABLE "Publication"
 ADD COLUMN "desiredPaused" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "acknowledgedPaused" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "commandVersion" INTEGER NOT NULL DEFAULT 0 CHECK ("commandVersion" >= 0),
 ADD COLUMN "acknowledgedVersion" INTEGER NOT NULL DEFAULT 0 CHECK ("acknowledgedVersion" >= 0),
 ADD CONSTRAINT "Publication_ack_version" CHECK ("acknowledgedVersion" <= "commandVersion");
