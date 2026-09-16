-- 0033 的 SQLite 等价增量：地图事实、评价、收据与提交水位。

CREATE TABLE map_ingest_heads (
  target_id TEXT NOT NULL PRIMARY KEY,
  committed_seq INTEGER NOT NULL CHECK (committed_seq >= 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE map_observations (
  id TEXT NOT NULL PRIMARY KEY,
  target_id TEXT NOT NULL,
  ingest_seq INTEGER NOT NULL CHECK (ingest_seq >= 1),
  dedupe_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('formal_run','trial','recorder','user_confirmed','probe','refresh','ai_explore','imported_metadata')),
  source_run_id TEXT,
  source_attempt_id TEXT,
  source_recording_id TEXT,
  capture_status TEXT NOT NULL CHECK (capture_status IN ('observed','missing','skipped')),
  envelope TEXT NOT NULL,
  FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX map_observations_target_dedupe_idx ON map_observations (target_id, dedupe_key);
CREATE UNIQUE INDEX map_observations_target_seq_idx ON map_observations (target_id, ingest_seq);
CREATE UNIQUE INDEX map_observations_target_id_idx ON map_observations (target_id, id);
CREATE UNIQUE INDEX map_observations_id_target_idx ON map_observations (id, target_id);
CREATE INDEX map_observations_observed_idx ON map_observations (target_id, observed_at, id);
CREATE INDEX map_observations_source_run_idx ON map_observations (source_run_id);
CREATE INDEX map_observations_source_attempt_idx ON map_observations (source_attempt_id);
CREATE INDEX map_observations_source_recording_idx ON map_observations (source_recording_id);

CREATE TABLE map_verifications (
  id TEXT NOT NULL PRIMARY KEY,
  target_id TEXT NOT NULL,
  ingest_seq INTEGER NOT NULL CHECK (ingest_seq >= 1),
  dedupe_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  dimension TEXT NOT NULL CHECK (dimension IN ('identity','locator','action','business')),
  verdict TEXT NOT NULL CHECK (verdict IN ('confirmed','rejected','unknown','not_observed')),
  envelope TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX map_verifications_target_dedupe_idx ON map_verifications (target_id, dedupe_key);
CREATE UNIQUE INDEX map_verifications_target_seq_idx ON map_verifications (target_id, ingest_seq);
CREATE UNIQUE INDEX map_verifications_target_id_idx ON map_verifications (target_id, id);
CREATE UNIQUE INDEX map_verifications_id_target_idx ON map_verifications (id, target_id);
CREATE INDEX map_verifications_seq_idx ON map_verifications (target_id, ingest_seq);
CREATE INDEX map_verifications_dimension_idx ON map_verifications (target_id, dimension);

CREATE TABLE map_verification_refs (
  verification_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  PRIMARY KEY (verification_id, observation_id),
  FOREIGN KEY (verification_id, target_id) REFERENCES map_verifications (id, target_id) ON DELETE RESTRICT,
  FOREIGN KEY (observation_id, target_id) REFERENCES map_observations (id, target_id) ON DELETE RESTRICT
);

CREATE INDEX map_verification_refs_observation_idx ON map_verification_refs (observation_id);

CREATE TABLE map_fact_receipts (
  target_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  fact_type TEXT NOT NULL CHECK (fact_type IN ('observation','verification')),
  fact_id TEXT NOT NULL,
  ingest_seq INTEGER NOT NULL CHECK (ingest_seq >= 1),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_id, dedupe_key),
  FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX map_fact_receipts_seq_idx ON map_fact_receipts (target_id, ingest_seq);
CREATE UNIQUE INDEX map_fact_receipts_fact_idx ON map_fact_receipts (target_id, fact_type, fact_id);

CREATE TABLE map_fact_contents (
  target_id TEXT NOT NULL,
  fact_type TEXT NOT NULL CHECK (fact_type IN ('observation','verification')),
  fact_id TEXT NOT NULL,
  content TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_id, fact_type, fact_id)
);

CREATE TABLE map_fact_availability (
  id TEXT NOT NULL PRIMARY KEY,
  target_id TEXT NOT NULL,
  fact_type TEXT NOT NULL CHECK (fact_type IN ('observation','verification')),
  fact_id TEXT NOT NULL,
  availability_revision INTEGER NOT NULL CHECK (availability_revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('expired','missing','deleted','unavailable')),
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX map_fact_availability_revision_idx
  ON map_fact_availability (target_id, fact_type, fact_id, availability_revision);
CREATE INDEX map_fact_availability_fact_idx
  ON map_fact_availability (target_id, fact_type, fact_id);
