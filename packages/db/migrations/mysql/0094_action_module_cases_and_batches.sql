-- 0094：动作模块测试用例、执行快照、结果判定与测试批次表 (MySQL)

CREATE TABLE module_test_cases (
  id VARCHAR(36) NOT NULL,
  module_id VARCHAR(36) NOT NULL,
  name VARCHAR(128) NOT NULL,
  revision INT NOT NULL DEFAULT 1,
  contract_digest VARCHAR(128) NOT NULL,
  inputs JSON NOT NULL,
  expected_module_outcome VARCHAR(32) NOT NULL DEFAULT 'VERIFIED',
  expected_failure_code VARCHAR(64),
  expected_outputs JSON NOT NULL,
  implementation_key VARCHAR(64) NOT NULL DEFAULT 'default',
  release_gate TINYINT NOT NULL DEFAULT 1,
  target_account_id VARCHAR(36),
  sample_review JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT module_test_cases_pkey PRIMARY KEY (id),
  CONSTRAINT module_test_cases_module_fk FOREIGN KEY (module_id) REFERENCES action_modules(id) ON DELETE CASCADE,
  CONSTRAINT module_test_cases_account_fk FOREIGN KEY (target_account_id) REFERENCES target_accounts(id) ON DELETE SET NULL,
  CONSTRAINT module_test_cases_status_check CHECK (status IN ('ACTIVE', 'ARCHIVED', 'INCOMPATIBLE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX module_test_cases_module_status_idx ON module_test_cases (module_id, status);
CREATE INDEX module_test_cases_module_gate_idx ON module_test_cases (module_id, release_gate);

CREATE TABLE module_case_executions (
  id VARCHAR(36) NOT NULL,
  case_id VARCHAR(36) NOT NULL,
  module_id VARCHAR(36) NOT NULL,
  case_revision INT NOT NULL,
  run_id VARCHAR(36) NOT NULL,
  comparator_version VARCHAR(32) NOT NULL DEFAULT 'v1',
  module_draft_revision INT,
  module_version_id VARCHAR(36),
  content_digest VARCHAR(128) NOT NULL,
  implementation_key VARCHAR(64) NOT NULL DEFAULT 'default',
  target_account_id VARCHAR(36),
  frozen_inputs JSON NOT NULL,
  frozen_expected_outcome VARCHAR(32) NOT NULL,
  frozen_expected_failure_code VARCHAR(64),
  frozen_expected_outputs JSON NOT NULL,
  idempotency_key VARCHAR(128),
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT module_case_executions_pkey PRIMARY KEY (id),
  CONSTRAINT module_case_executions_case_fk FOREIGN KEY (case_id) REFERENCES module_test_cases(id) ON DELETE CASCADE,
  CONSTRAINT module_case_executions_module_fk FOREIGN KEY (module_id) REFERENCES action_modules(id) ON DELETE CASCADE,
  CONSTRAINT module_case_executions_run_fk FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  CONSTRAINT module_case_executions_version_fk FOREIGN KEY (module_version_id) REFERENCES action_module_versions(id) ON DELETE SET NULL,
  CONSTRAINT module_case_executions_account_fk FOREIGN KEY (target_account_id) REFERENCES target_accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX module_case_executions_run_idx ON module_case_executions (run_id);
CREATE INDEX module_case_executions_case_idx ON module_case_executions (case_id, case_revision);
CREATE INDEX module_case_executions_module_idx ON module_case_executions (module_id, created_at);

CREATE TABLE module_case_results (
  id VARCHAR(36) NOT NULL,
  execution_id VARCHAR(36) NOT NULL,
  case_id VARCHAR(36) NOT NULL,
  run_id VARCHAR(36) NOT NULL,
  revision INT NOT NULL DEFAULT 1,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  outcome_matched TINYINT,
  outputs_matched TINYINT,
  evidence_complete TINYINT,
  failure_reason TEXT,
  details JSON,
  projector_version VARCHAR(32) NOT NULL DEFAULT 'v1',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  settled_at DATETIME(3),
  CONSTRAINT module_case_results_pkey PRIMARY KEY (id),
  CONSTRAINT module_case_results_exec_fk FOREIGN KEY (execution_id) REFERENCES module_case_executions(id) ON DELETE CASCADE,
  CONSTRAINT module_case_results_case_fk FOREIGN KEY (case_id) REFERENCES module_test_cases(id) ON DELETE CASCADE,
  CONSTRAINT module_case_results_run_fk FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  CONSTRAINT module_case_results_status_check CHECK (status IN ('PENDING', 'PASS', 'FAIL', 'INCONCLUSIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX module_case_results_execution_rev_idx ON module_case_results (execution_id, revision);
CREATE INDEX module_case_results_case_status_idx ON module_case_results (case_id, status);
CREATE INDEX module_case_results_run_idx ON module_case_results (run_id);

CREATE TABLE module_test_batches (
  id VARCHAR(36) NOT NULL,
  module_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36),
  total_cases INT NOT NULL,
  passed_cases INT NOT NULL DEFAULT 0,
  failed_cases INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
  halt_reason TEXT,
  case_execution_ids JSON NOT NULL,
  confirmed_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT module_test_batches_pkey PRIMARY KEY (id),
  CONSTRAINT module_test_batches_module_fk FOREIGN KEY (module_id) REFERENCES action_modules(id) ON DELETE CASCADE,
  CONSTRAINT module_test_batches_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE,
  CONSTRAINT module_test_batches_account_fk FOREIGN KEY (target_account_id) REFERENCES target_accounts(id) ON DELETE SET NULL,
  CONSTRAINT module_test_batches_status_check CHECK (status IN ('RUNNING', 'COMPLETED', 'HALTED', 'FAILED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX module_test_batches_module_idx ON module_test_batches (module_id, created_at);
