-- 0033 的 MySQL 等价增量：地图事实、评价、收据与提交水位。

CREATE TABLE map_ingest_heads (
  target_id VARCHAR(36) NOT NULL,
  committed_seq INT NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_ingest_heads_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_ingest_heads_seq_check CHECK (committed_seq >= 0),
  CONSTRAINT map_ingest_heads_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_observations (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  ingest_seq INT NOT NULL,
  dedupe_key VARCHAR(192) NOT NULL,
  payload_digest VARCHAR(64) NOT NULL,
  observed_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  source_type VARCHAR(32) NOT NULL,
  source_run_id VARCHAR(36),
  source_attempt_id VARCHAR(36),
  source_recording_id VARCHAR(36),
  capture_status VARCHAR(16) NOT NULL,
  envelope JSON NOT NULL,
  CONSTRAINT map_observations_pkey PRIMARY KEY (id),
  CONSTRAINT map_observations_seq_check CHECK (ingest_seq >= 1),
  CONSTRAINT map_observations_source_type_check
    CHECK (source_type IN ('formal_run','trial','recorder','user_confirmed','probe','refresh','ai_explore','imported_metadata')),
  CONSTRAINT map_observations_capture_status_check
    CHECK (capture_status IN ('observed','missing','skipped')),
  CONSTRAINT map_observations_digest_check CHECK (CHAR_LENGTH(payload_digest) = 64),
  CONSTRAINT map_observations_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX map_observations_target_dedupe_idx ON map_observations (target_id, dedupe_key);
CREATE UNIQUE INDEX map_observations_target_seq_idx ON map_observations (target_id, ingest_seq);
CREATE UNIQUE INDEX map_observations_target_id_idx ON map_observations (target_id, id);
CREATE UNIQUE INDEX map_observations_id_target_idx ON map_observations (id, target_id);
CREATE INDEX map_observations_observed_idx ON map_observations (target_id, observed_at, id);
CREATE INDEX map_observations_source_run_idx ON map_observations (source_run_id);
CREATE INDEX map_observations_source_attempt_idx ON map_observations (source_attempt_id);
CREATE INDEX map_observations_source_recording_idx ON map_observations (source_recording_id);

CREATE TABLE map_verifications (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  ingest_seq INT NOT NULL,
  dedupe_key VARCHAR(192) NOT NULL,
  payload_digest VARCHAR(64) NOT NULL,
  dimension VARCHAR(16) NOT NULL,
  verdict VARCHAR(16) NOT NULL,
  envelope JSON NOT NULL,
  evaluated_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_verifications_pkey PRIMARY KEY (id),
  CONSTRAINT map_verifications_seq_check CHECK (ingest_seq >= 1),
  CONSTRAINT map_verifications_dimension_check
    CHECK (dimension IN ('identity','locator','action','business')),
  CONSTRAINT map_verifications_verdict_check
    CHECK (verdict IN ('confirmed','rejected','unknown','not_observed')),
  CONSTRAINT map_verifications_digest_check CHECK (CHAR_LENGTH(payload_digest) = 64),
  CONSTRAINT map_verifications_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX map_verifications_target_dedupe_idx ON map_verifications (target_id, dedupe_key);
CREATE UNIQUE INDEX map_verifications_target_seq_idx ON map_verifications (target_id, ingest_seq);
CREATE UNIQUE INDEX map_verifications_target_id_idx ON map_verifications (target_id, id);
CREATE UNIQUE INDEX map_verifications_id_target_idx ON map_verifications (id, target_id);
CREATE INDEX map_verifications_seq_idx ON map_verifications (target_id, ingest_seq);
CREATE INDEX map_verifications_dimension_idx ON map_verifications (target_id, dimension);

CREATE TABLE map_verification_refs (
  verification_id VARCHAR(36) NOT NULL,
  observation_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  CONSTRAINT map_verification_refs_pkey PRIMARY KEY (verification_id, observation_id),
  CONSTRAINT map_verification_refs_verification_fk
    FOREIGN KEY (verification_id, target_id) REFERENCES map_verifications (id, target_id),
  CONSTRAINT map_verification_refs_observation_fk
    FOREIGN KEY (observation_id, target_id) REFERENCES map_observations (id, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX map_verification_refs_observation_idx ON map_verification_refs (observation_id);

CREATE TABLE map_fact_receipts (
  target_id VARCHAR(36) NOT NULL,
  dedupe_key VARCHAR(192) NOT NULL,
  fact_type VARCHAR(16) NOT NULL,
  fact_id VARCHAR(36) NOT NULL,
  ingest_seq INT NOT NULL,
  payload_digest VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_fact_receipts_pkey PRIMARY KEY (target_id, dedupe_key),
  CONSTRAINT map_fact_receipts_seq_check CHECK (ingest_seq >= 1),
  CONSTRAINT map_fact_receipts_type_check CHECK (fact_type IN ('observation','verification')),
  CONSTRAINT map_fact_receipts_digest_check CHECK (CHAR_LENGTH(payload_digest) = 64),
  CONSTRAINT map_fact_receipts_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX map_fact_receipts_seq_idx ON map_fact_receipts (target_id, ingest_seq);
CREATE UNIQUE INDEX map_fact_receipts_fact_idx ON map_fact_receipts (target_id, fact_type, fact_id);

CREATE TABLE map_fact_contents (
  target_id VARCHAR(36) NOT NULL,
  fact_type VARCHAR(16) NOT NULL,
  fact_id VARCHAR(36) NOT NULL,
  content JSON,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_fact_contents_pkey PRIMARY KEY (target_id, fact_type, fact_id),
  CONSTRAINT map_fact_contents_type_check CHECK (fact_type IN ('observation','verification'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_fact_availability (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  fact_type VARCHAR(16) NOT NULL,
  fact_id VARCHAR(36) NOT NULL,
  availability_revision INT NOT NULL,
  status VARCHAR(16) NOT NULL,
  reason VARCHAR(64),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_fact_availability_pkey PRIMARY KEY (id),
  CONSTRAINT map_fact_availability_revision_check CHECK (availability_revision >= 1),
  CONSTRAINT map_fact_availability_type_check CHECK (fact_type IN ('observation','verification')),
  CONSTRAINT map_fact_availability_status_check
    CHECK (status IN ('expired','missing','deleted','unavailable'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX map_fact_availability_revision_idx
  ON map_fact_availability (target_id, fact_type, fact_id, availability_revision);
CREATE INDEX map_fact_availability_fact_idx
  ON map_fact_availability (target_id, fact_type, fact_id);
