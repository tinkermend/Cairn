-- 0054：模块调用结果派生表，按 (run_id, invocation_id) 幂等覆盖。

CREATE TABLE "__SCHEMA__".module_invocation_results (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  invocation_id UUID NOT NULL,
  projector_version INTEGER NOT NULL,
  module_id UUID NOT NULL REFERENCES "__SCHEMA__".action_modules(id) ON DELETE RESTRICT,
  module_version_id UUID REFERENCES "__SCHEMA__".action_module_versions(id) ON DELETE RESTRICT,
  module_draft_revision INTEGER,
  run_kind TEXT NOT NULL,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  target_account_id UUID REFERENCES "__SCHEMA__".target_accounts(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL,
  attribution TEXT NOT NULL,
  failed_expanded_step_id UUID,
  error_category TEXT,
  error_code TEXT,
  manual_requirements_unverified INTEGER NOT NULL DEFAULT 0,
  verification_strength TEXT NOT NULL,
  retried_success INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  ai_calls INTEGER NOT NULL DEFAULT 0,
  ai_cost TEXT,
  source_run_event_seq INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT module_invocation_results_run_kind_check CHECK (run_kind IN ('published', 'trial', 'service', 'module_verification', 'map_job')),
  CONSTRAINT module_invocation_results_outcome_check CHECK (outcome IN ('VERIFIED', 'FAILED_IMPLEMENTATION', 'FAILED_VERIFICATION', 'NEEDS_REVIEW', 'NOT_REACHED', 'CANCELLED', 'UNKNOWN')),
  CONSTRAINT module_invocation_results_attribution_check CHECK (attribution IN ('MODULE', 'EXTERNAL_INFRA', 'UPSTREAM', 'UNKNOWN')),
  CONSTRAINT module_invocation_results_strength_check CHECK (verification_strength IN ('sufficient', 'insufficient')),
  CONSTRAINT module_invocation_results_retried_check CHECK (retried_success IN (0, 1))
);
CREATE UNIQUE INDEX module_invocation_results_run_invocation_idx
  ON "__SCHEMA__".module_invocation_results (run_id, invocation_id);
CREATE INDEX module_invocation_results_version_finished_idx
  ON "__SCHEMA__".module_invocation_results (module_version_id, finished_at);
CREATE INDEX module_invocation_results_module_finished_idx
  ON "__SCHEMA__".module_invocation_results (module_id, finished_at);
CREATE INDEX module_invocation_results_account_finished_idx
  ON "__SCHEMA__".module_invocation_results (target_account_id, finished_at);
