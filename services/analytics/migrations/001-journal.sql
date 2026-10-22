CREATE TABLE analytics_event (
  key varchar(180) PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  hash char(64) NOT NULL,
  fact jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE analytics_checkpoint (
  id integer PRIMARY KEY CHECK (id = 1),
  generation uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
