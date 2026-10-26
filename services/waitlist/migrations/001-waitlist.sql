CREATE TABLE waitlist_event (
  sale_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  title text NOT NULL,
  enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE waitlist_entry (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  sale_id uuid NOT NULL REFERENCES waitlist_event,
  buyer_subject varchar(255) NOT NULL,
  category_id varchar(32) NOT NULL,
  contact bytea NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('WAITING','RESERVING','OFFERED','CANCELLING','PURCHASED','EXPIRED','CANCELLED','SKIPPED','CLOSED')),
  cancel_reason varchar(16) NOT NULL DEFAULT 'CANCELLED',
  attempt_id uuid,
  order_id uuid,
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX waitlist_active_buyer ON waitlist_entry(sale_id,buyer_subject)
  WHERE state IN ('WAITING','RESERVING','OFFERED','CANCELLING');
CREATE UNIQUE INDEX waitlist_active_offer ON waitlist_entry(sale_id,category_id)
  WHERE state IN ('RESERVING','OFFERED','CANCELLING');
CREATE INDEX waitlist_fifo ON waitlist_entry(sale_id,category_id,sequence) WHERE state = 'WAITING';
CREATE INDEX waitlist_buyer ON waitlist_entry(buyer_subject,sequence DESC);
CREATE TABLE workflow_dispatch (sale_id uuid PRIMARY KEY REFERENCES waitlist_event, revision bigint NOT NULL DEFAULT 1, delivered bigint NOT NULL DEFAULT 0);
CREATE TABLE "Outbox" (
  id uuid PRIMARY KEY, envelope jsonb NOT NULL, "sentAt" timestamptz,
  "availableAt" timestamptz NOT NULL DEFAULT clock_timestamp(), attempts integer NOT NULL DEFAULT 0, lease uuid
);
CREATE INDEX waitlist_outbox_pending ON "Outbox"("availableAt",id) WHERE "sentAt" IS NULL;
CREATE TABLE "DeliveryJob" (
  id uuid PRIMARY KEY REFERENCES waitlist_entry, state varchar(10) NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','SENT','SKIPPED','DEAD')),
  attempts integer NOT NULL DEFAULT 0, "nextRunAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease uuid, traceparent varchar(55)
);
CREATE INDEX waitlist_mail_pending ON "DeliveryJob"(state,"nextRunAt",id);
