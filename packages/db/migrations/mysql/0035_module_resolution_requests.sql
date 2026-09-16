-- 0051 的 MySQL 等价增量：编写期模块映射请求。
CREATE TABLE module_resolution_requests (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  scenario_id VARCHAR(36),
  actor_id VARCHAR(36) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_digest VARCHAR(64) NOT NULL,
  expression VARCHAR(512) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  term_revision VARCHAR(128),
  status VARCHAR(16) NOT NULL,
  candidates JSON NOT NULL,
  input_suggestions JSON NOT NULL,
  unknowns JSON NOT NULL,
  ai_skipped VARCHAR(32),
  outcome VARCHAR(16) NOT NULL DEFAULT 'pending',
  accepted_module_version_id VARCHAR(36),
  accept_idempotency_key VARCHAR(128),
  accept_response JSON,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT module_resolution_requests_pkey PRIMARY KEY (id),
  CONSTRAINT module_resolution_requests_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT module_resolution_requests_scenario_fk FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE RESTRICT,
  CONSTRAINT module_resolution_requests_actor_fk FOREIGN KEY (actor_id) REFERENCES console_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT module_resolution_requests_version_fk FOREIGN KEY (accepted_module_version_id) REFERENCES action_module_versions(id) ON DELETE RESTRICT,
  CONSTRAINT module_resolution_requests_mode_check CHECK (mode IN ('rules', 'rules_then_ai')),
  CONSTRAINT module_resolution_requests_status_check CHECK (status IN ('matched', 'suggested', 'ambiguous', 'no_match')),
  CONSTRAINT module_resolution_requests_outcome_check CHECK (outcome IN ('pending', 'accepted', 'rejected', 'abandoned'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX module_resolution_requests_actor_key_idx ON module_resolution_requests (actor_id, idempotency_key);
CREATE INDEX module_resolution_requests_target_created_idx ON module_resolution_requests (target_id, created_at);
CREATE INDEX module_resolution_requests_created_idx ON module_resolution_requests (created_at);
