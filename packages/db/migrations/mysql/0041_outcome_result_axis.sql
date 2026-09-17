-- 0057 的 MySQL 等价增量：结果轴与 Outcome 契约底座

ALTER TABLE runs
  ADD COLUMN outcome_status VARCHAR(32) NOT NULL DEFAULT 'NOT_EVALUATED',
  ADD CONSTRAINT runs_outcome_status_check CHECK (
    outcome_status IN ('PASS', 'WARN', 'FAIL', 'UNKNOWN', 'NOT_EVALUATED')
  );

ALTER TABLE step_runs
  ADD COLUMN outcome_status VARCHAR(32) NOT NULL DEFAULT 'NOT_EVALUATED',
  ADD CONSTRAINT step_runs_outcome_status_check CHECK (
    outcome_status IN ('PASS', 'WARN', 'FAIL', 'UNKNOWN', 'NOT_EVALUATED')
  );

CREATE TABLE outcome_results (
  id VARCHAR(36) NOT NULL,
  run_id VARCHAR(36) NOT NULL,
  step_run_id VARCHAR(36) NOT NULL,
  attempt_id VARCHAR(36) NOT NULL,
  contract_id VARCHAR(36) NOT NULL,
  scope VARCHAR(32) NOT NULL,
  meaning TEXT NOT NULL,
  severity VARCHAR(32) NOT NULL,
  on_violation VARCHAR(32) NOT NULL,
  provenance VARCHAR(32) NOT NULL,
  verdict VARCHAR(32) NOT NULL,
  expected JSON,
  actual JSON,
  evidence_id VARCHAR(36),
  details JSON,
  evaluated_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT outcome_results_pkey PRIMARY KEY (id),
  CONSTRAINT outcome_results_run_fk FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  CONSTRAINT outcome_results_step_run_fk FOREIGN KEY (step_run_id) REFERENCES step_runs(id) ON DELETE RESTRICT,
  CONSTRAINT outcome_results_attempt_fk FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE RESTRICT,
  CONSTRAINT outcome_results_evidence_fk FOREIGN KEY (evidence_id) REFERENCES evidences(id) ON DELETE RESTRICT,
  CONSTRAINT outcome_results_scope_check CHECK (scope IN ('step', 'scenario')),
  CONSTRAINT outcome_results_severity_check CHECK (severity IN ('MUST', 'SHOULD', 'INFO')),
  CONSTRAINT outcome_results_on_violation_check CHECK (on_violation IN ('halt', 'continue')),
  CONSTRAINT outcome_results_provenance_check CHECK (
    provenance IN ('manual', 'module_inherited', 'recorded', 'ai_compiled', 'legacy_assert')
  ),
  CONSTRAINT outcome_results_verdict_check CHECK (verdict IN ('PASS', 'WARN', 'FAIL', 'UNKNOWN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX outcome_results_attempt_contract_idx
  ON outcome_results (attempt_id, contract_id);

CREATE INDEX outcome_results_run_idx
  ON outcome_results (run_id);

CREATE INDEX outcome_results_step_run_idx
  ON outcome_results (step_run_id);

CREATE INDEX outcome_results_verdict_idx
  ON outcome_results (verdict);
