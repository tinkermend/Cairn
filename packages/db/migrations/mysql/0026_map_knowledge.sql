-- 0042 的 MySQL 等价增量：目标术语、修订与知识编写建议。

CREATE TABLE map_terminology_entries (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  request_key VARCHAR(128) NOT NULL,
  canonical_name VARCHAR(128) NOT NULL,
  aliases JSON NOT NULL,
  meaning TEXT NOT NULL,
  condition_snapshot JSON,
  term_status VARCHAR(16) NOT NULL,
  revision INT NOT NULL,
  sources JSON NOT NULL,
  created_by_console_account_id VARCHAR(36) NOT NULL,
  updated_by_console_account_id VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_terminology_entries_pkey PRIMARY KEY (id),
  CONSTRAINT map_terminology_entries_status_check CHECK (term_status IN ('candidate','confirmed','retired')),
  CONSTRAINT map_terminology_entries_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_terminology_entries_key_idx ON map_terminology_entries (target_id, request_key);
CREATE INDEX map_terminology_entries_target_idx ON map_terminology_entries (target_id, canonical_name);

CREATE TABLE map_terminology_revisions (
  id VARCHAR(36) NOT NULL,
  term_id VARCHAR(36) NOT NULL,
  revision INT NOT NULL,
  payload JSON NOT NULL,
  actor_id VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_terminology_revisions_pkey PRIMARY KEY (id),
  CONSTRAINT map_terminology_revisions_unique UNIQUE (term_id, revision),
  CONSTRAINT map_terminology_revisions_term_fk FOREIGN KEY (term_id) REFERENCES map_terminology_entries(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_authoring_proposals (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  scenario_id VARCHAR(36) NOT NULL,
  request_key VARCHAR(128) NOT NULL,
  accept_key VARCHAR(128),
  proposal_status VARCHAR(16) NOT NULL,
  question TEXT NOT NULL,
  baseline JSON NOT NULL,
  document JSON,
  diffs JSON NOT NULL,
  diagnostics JSON NOT NULL,
  sources JSON NOT NULL,
  unknowns JSON NOT NULL,
  term_candidates JSON NOT NULL,
  suggested_modules JSON NOT NULL,
  suggested_bindings JSON NOT NULL,
  accepted_revision INT,
  actor_id VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_authoring_proposals_pkey PRIMARY KEY (id),
  CONSTRAINT map_authoring_proposals_status_check CHECK (proposal_status IN (
    'requested','generating','proposed','needs_input','unsupported','failed','cancelled','accepted','stale','rejected'
  )),
  CONSTRAINT map_authoring_proposals_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT map_authoring_proposals_scenario_fk FOREIGN KEY (scenario_id) REFERENCES scenarios(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_authoring_proposals_key_idx ON map_authoring_proposals (scenario_id, request_key);
CREATE INDEX map_authoring_proposals_target_idx ON map_authoring_proposals (target_id, updated_at);
