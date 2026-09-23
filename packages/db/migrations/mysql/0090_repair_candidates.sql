-- 0090：受控修复候选 (repair_candidates) 持久化与验证状态（MySQL 等价）。

CREATE TABLE repair_candidates (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  candidate_id VARCHAR(64) NOT NULL UNIQUE,
  run_id VARCHAR(36) NOT NULL,
  source_attempt_id VARCHAR(36) NOT NULL,
  patch_target_ref JSON NOT NULL,
  authoring_origin JSON NULL,
  patch JSON NOT NULL,
  hypothesis TEXT NOT NULL,
  applicability TEXT NULL,
  digest_manifest JSON NOT NULL,
  guard_results JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'proposed',
  validation_scope JSON NOT NULL,
  validation_refs JSON NULL,
  adoption JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  CONSTRAINT repair_candidates_status_check
    CHECK (status IN ('proposed', 'blocked', 'validating', 'validated', 'rejected', 'expired', 'adopted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX repair_candidates_run_idx
  ON repair_candidates (run_id);

CREATE INDEX repair_candidates_status_idx
  ON repair_candidates (status);

CREATE INDEX repair_candidates_source_attempt_idx
  ON repair_candidates (source_attempt_id);
