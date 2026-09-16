-- 0033：地图不可变观察、追加评价、统一收据与提交水位。

CREATE TABLE "__SCHEMA__".map_ingest_heads (
  target_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  committed_seq INTEGER NOT NULL CHECK (committed_seq >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "__SCHEMA__".map_observations (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  ingest_seq INTEGER NOT NULL CHECK (ingest_seq >= 1),
  dedupe_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_type TEXT NOT NULL,
  source_run_id UUID,
  source_attempt_id UUID,
  source_recording_id UUID,
  capture_status TEXT NOT NULL,
  envelope JSONB NOT NULL,
  CONSTRAINT map_observations_source_type_check
    CHECK (source_type IN ('formal_run','trial','recorder','user_confirmed','probe','refresh','ai_explore','imported_metadata')),
  CONSTRAINT map_observations_capture_status_check
    CHECK (capture_status IN ('observed','missing','skipped')),
  CONSTRAINT map_observations_digest_check CHECK (payload_digest ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX map_observations_target_dedupe_idx
  ON "__SCHEMA__".map_observations (target_id, dedupe_key);
CREATE UNIQUE INDEX map_observations_target_seq_idx
  ON "__SCHEMA__".map_observations (target_id, ingest_seq);
CREATE UNIQUE INDEX map_observations_target_id_idx
  ON "__SCHEMA__".map_observations (target_id, id);
CREATE UNIQUE INDEX map_observations_id_target_idx
  ON "__SCHEMA__".map_observations (id, target_id);
CREATE INDEX map_observations_observed_idx
  ON "__SCHEMA__".map_observations (target_id, observed_at, id);
CREATE INDEX map_observations_source_run_idx
  ON "__SCHEMA__".map_observations (source_run_id);
CREATE INDEX map_observations_source_attempt_idx
  ON "__SCHEMA__".map_observations (source_attempt_id);
CREATE INDEX map_observations_source_recording_idx
  ON "__SCHEMA__".map_observations (source_recording_id);

CREATE TABLE "__SCHEMA__".map_verifications (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  ingest_seq INTEGER NOT NULL CHECK (ingest_seq >= 1),
  dedupe_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  dimension TEXT NOT NULL,
  verdict TEXT NOT NULL,
  envelope JSONB NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_verifications_dimension_check
    CHECK (dimension IN ('identity','locator','action','business')),
  CONSTRAINT map_verifications_verdict_check
    CHECK (verdict IN ('confirmed','rejected','unknown','not_observed')),
  CONSTRAINT map_verifications_digest_check CHECK (payload_digest ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX map_verifications_target_dedupe_idx
  ON "__SCHEMA__".map_verifications (target_id, dedupe_key);
CREATE UNIQUE INDEX map_verifications_target_seq_idx
  ON "__SCHEMA__".map_verifications (target_id, ingest_seq);
CREATE UNIQUE INDEX map_verifications_target_id_idx
  ON "__SCHEMA__".map_verifications (target_id, id);
CREATE UNIQUE INDEX map_verifications_id_target_idx
  ON "__SCHEMA__".map_verifications (id, target_id);
CREATE INDEX map_verifications_seq_idx
  ON "__SCHEMA__".map_verifications (target_id, ingest_seq);
CREATE INDEX map_verifications_dimension_idx
  ON "__SCHEMA__".map_verifications (target_id, dimension);

CREATE TABLE "__SCHEMA__".map_verification_refs (
  verification_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  target_id UUID NOT NULL,
  PRIMARY KEY (verification_id, observation_id),
  CONSTRAINT map_verification_refs_verification_fk
    FOREIGN KEY (verification_id, target_id)
    REFERENCES "__SCHEMA__".map_verifications (id, target_id)
    ON DELETE RESTRICT,
  CONSTRAINT map_verification_refs_observation_fk
    FOREIGN KEY (observation_id, target_id)
    REFERENCES "__SCHEMA__".map_observations (id, target_id)
    ON DELETE RESTRICT
);

CREATE INDEX map_verification_refs_observation_idx
  ON "__SCHEMA__".map_verification_refs (observation_id);

CREATE TABLE "__SCHEMA__".map_fact_receipts (
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  dedupe_key TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  fact_id UUID NOT NULL,
  ingest_seq INTEGER NOT NULL CHECK (ingest_seq >= 1),
  payload_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, dedupe_key),
  CONSTRAINT map_fact_receipts_type_check CHECK (fact_type IN ('observation','verification')),
  CONSTRAINT map_fact_receipts_digest_check CHECK (payload_digest ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX map_fact_receipts_seq_idx
  ON "__SCHEMA__".map_fact_receipts (target_id, ingest_seq);
CREATE UNIQUE INDEX map_fact_receipts_fact_idx
  ON "__SCHEMA__".map_fact_receipts (target_id, fact_type, fact_id);

CREATE TABLE "__SCHEMA__".map_fact_contents (
  target_id UUID NOT NULL,
  fact_type TEXT NOT NULL,
  fact_id UUID NOT NULL,
  content JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, fact_type, fact_id),
  CONSTRAINT map_fact_contents_type_check CHECK (fact_type IN ('observation','verification'))
);

CREATE TABLE "__SCHEMA__".map_fact_availability (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL,
  fact_type TEXT NOT NULL,
  fact_id UUID NOT NULL,
  availability_revision INTEGER NOT NULL CHECK (availability_revision >= 1),
  status TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_fact_availability_type_check CHECK (fact_type IN ('observation','verification')),
  CONSTRAINT map_fact_availability_status_check
    CHECK (status IN ('expired','missing','deleted','unavailable'))
);

CREATE UNIQUE INDEX map_fact_availability_revision_idx
  ON "__SCHEMA__".map_fact_availability (target_id, fact_type, fact_id, availability_revision);
CREATE INDEX map_fact_availability_fact_idx
  ON "__SCHEMA__".map_fact_availability (target_id, fact_type, fact_id);
