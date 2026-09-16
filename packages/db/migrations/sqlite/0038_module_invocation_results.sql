-- 0054 的 SQLite 等价增量：模块调用结果派生表。
CREATE TABLE module_invocation_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  invocation_id TEXT NOT NULL,
  projector_version INTEGER NOT NULL,
  module_id TEXT NOT NULL REFERENCES action_modules(id) ON DELETE RESTRICT,
  module_version_id TEXT REFERENCES action_module_versions(id) ON DELETE RESTRICT,
  module_draft_revision INTEGER,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('published', 'trial', 'service', 'module_verification', 'map_job')),
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE RESTRICT,
  target_account_id TEXT REFERENCES target_accounts(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('VERIFIED', 'FAILED_IMPLEMENTATION', 'FAILED_VERIFICATION', 'NEEDS_REVIEW', 'NOT_REACHED', 'CANCELLED', 'UNKNOWN')),
  attribution TEXT NOT NULL CHECK (attribution IN ('MODULE', 'EXTERNAL_INFRA', 'UPSTREAM', 'UNKNOWN')),
  failed_expanded_step_id TEXT,
  error_category TEXT,
  error_code TEXT,
  manual_requirements_unverified INTEGER NOT NULL DEFAULT 0,
  verification_strength TEXT NOT NULL CHECK (verification_strength IN ('sufficient', 'insufficient')),
  retried_success INTEGER NOT NULL DEFAULT 0 CHECK (retried_success IN (0, 1)),
  started_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  ai_calls INTEGER NOT NULL DEFAULT 0,
  ai_cost TEXT,
  source_run_event_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX module_invocation_results_run_invocation_idx ON module_invocation_results (run_id, invocation_id);
CREATE INDEX module_invocation_results_version_finished_idx ON module_invocation_results (module_version_id, finished_at);
CREATE INDEX module_invocation_results_module_finished_idx ON module_invocation_results (module_id, finished_at);
CREATE INDEX module_invocation_results_account_finished_idx ON module_invocation_results (target_account_id, finished_at);
