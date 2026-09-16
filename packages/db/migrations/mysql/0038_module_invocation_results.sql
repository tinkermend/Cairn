-- 0054 的 MySQL 等价增量：模块调用结果派生表。
CREATE TABLE module_invocation_results (
  id VARCHAR(36) NOT NULL,
  run_id VARCHAR(36) NOT NULL,
  invocation_id VARCHAR(36) NOT NULL,
  projector_version INT NOT NULL,
  module_id VARCHAR(36) NOT NULL,
  module_version_id VARCHAR(36),
  module_draft_revision INT,
  run_kind VARCHAR(32) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36),
  outcome VARCHAR(32) NOT NULL,
  attribution VARCHAR(32) NOT NULL,
  failed_expanded_step_id VARCHAR(36),
  error_category VARCHAR(64),
  error_code VARCHAR(128),
  manual_requirements_unverified INT NOT NULL DEFAULT 0,
  verification_strength VARCHAR(16) NOT NULL,
  retried_success TINYINT NOT NULL DEFAULT 0,
  started_at DATETIME(3),
  finished_at DATETIME(3),
  duration_ms INT,
  ai_calls INT NOT NULL DEFAULT 0,
  ai_cost VARCHAR(64),
  source_run_event_seq INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT module_invocation_results_pkey PRIMARY KEY (id),
  CONSTRAINT module_invocation_results_run_fk FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  CONSTRAINT module_invocation_results_module_fk FOREIGN KEY (module_id) REFERENCES action_modules(id) ON DELETE RESTRICT,
  CONSTRAINT module_invocation_results_version_fk FOREIGN KEY (module_version_id) REFERENCES action_module_versions(id) ON DELETE RESTRICT,
  CONSTRAINT module_invocation_results_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT module_invocation_results_account_fk FOREIGN KEY (target_account_id) REFERENCES target_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT module_invocation_results_run_kind_check CHECK (run_kind IN ('published', 'trial', 'service', 'module_verification', 'map_job')),
  CONSTRAINT module_invocation_results_outcome_check CHECK (outcome IN ('VERIFIED', 'FAILED_IMPLEMENTATION', 'FAILED_VERIFICATION', 'NEEDS_REVIEW', 'NOT_REACHED', 'CANCELLED', 'UNKNOWN')),
  CONSTRAINT module_invocation_results_attribution_check CHECK (attribution IN ('MODULE', 'EXTERNAL_INFRA', 'UPSTREAM', 'UNKNOWN')),
  CONSTRAINT module_invocation_results_strength_check CHECK (verification_strength IN ('sufficient', 'insufficient')),
  CONSTRAINT module_invocation_results_retried_check CHECK (retried_success IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX module_invocation_results_run_invocation_idx ON module_invocation_results (run_id, invocation_id);
CREATE INDEX module_invocation_results_version_finished_idx ON module_invocation_results (module_version_id, finished_at);
CREATE INDEX module_invocation_results_module_finished_idx ON module_invocation_results (module_id, finished_at);
CREATE INDEX module_invocation_results_account_finished_idx ON module_invocation_results (target_account_id, finished_at);
