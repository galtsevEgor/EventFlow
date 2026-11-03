CREATE TABLE recommendation_projection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  building_generation UUID NOT NULL,
  building_model TEXT NOT NULL,
  active_generation UUID,
  active_model TEXT,
  cursor BIGINT NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  through BIGINT NOT NULL DEFAULT 0 CHECK (through >= cursor),
  heartbeat TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE recommendation_documents (
  generation UUID NOT NULL,
  event_id UUID NOT NULL,
  source_position BIGINT NOT NULL CHECK (source_position > 0),
  document JSONB,
  embedding vector(384),
  PRIMARY KEY (generation, event_id),
  CHECK ((document IS NULL) = (embedding IS NULL))
);
CREATE INDEX recommendation_vectors ON recommendation_documents USING hnsw (embedding vector_cosine_ops);
CREATE TABLE recommendation_interest_vectors (
  generation UUID NOT NULL,
  interest_id TEXT NOT NULL,
  embedding vector(384) NOT NULL,
  PRIMARY KEY (generation, interest_id)
);
CREATE TABLE recommendation_profiles (
  actor UUID PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  interests TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (cardinality(interests) <= 8)
);
CREATE TABLE recommendation_favorites (
  actor UUID NOT NULL REFERENCES recommendation_profiles(actor),
  event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor, event_id)
);
