-- PostgreSQL 0089 的 MySQL 等价增量：解析决策事实。

CREATE TABLE resolution_decisions (
  id VARCHAR(36) NOT NULL,
  run_id VARCHAR(36) NOT NULL,
  step_run_id VARCHAR(36) NOT NULL,
  attempt_id VARCHAR(36) NOT NULL,
  step_id VARCHAR(36) NOT NULL,
  effective_policy VARCHAR(32) NOT NULL,
  decision_kind VARCHAR(16) NOT NULL,
  reason_code VARCHAR(64) NULL,
  semantic_digest VARCHAR(64) NULL,
  rungs_json JSON NOT NULL,
  evidence_refs JSON NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT resolution_decisions_pkey PRIMARY KEY (id),
  CONSTRAINT resolution_decisions_run_fk FOREIGN KEY (run_id) REFERENCES runs(id),
  CONSTRAINT resolution_decisions_step_run_fk FOREIGN KEY (step_run_id) REFERENCES step_runs(id),
  CONSTRAINT resolution_decisions_attempt_fk FOREIGN KEY (attempt_id) REFERENCES attempts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX resolution_decisions_attempt ON resolution_decisions (attempt_id);
CREATE INDEX resolution_decisions_run_idx ON resolution_decisions (run_id, step_run_id, created_at);
CREATE INDEX resolution_decisions_decision_idx ON resolution_decisions (decision_kind);
