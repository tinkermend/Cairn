-- 0126：探索状态配方、三级状态事实、控件发现、审核、遍历事实与入口请求配置文件，map_jobs 扩充 needs_review 状态。

ALTER TABLE "__SCHEMA__".map_jobs DROP CONSTRAINT IF EXISTS map_jobs_status_check;
ALTER TABLE "__SCHEMA__".map_jobs
  ADD CONSTRAINT map_jobs_status_check CHECK (job_status IN ('queued','running','completed','cancelled','failed','needs_review'));

CREATE TABLE "__SCHEMA__".explore_state_recipes (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  target_account_id UUID NOT NULL REFERENCES "__SCHEMA__".target_accounts(id) ON DELETE RESTRICT,
  map_safe_entry_id UUID NOT NULL REFERENCES "__SCHEMA__".map_safe_entries(id) ON DELETE RESTRICT,
  safe_entry_version INTEGER NOT NULL,
  recipe_name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state_rule_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending_review', 'approved', 'rejected', 'archived')),
  steps_json JSONB NOT NULL,
  safety_basis_json JSONB NOT NULL,
  usage_limit INTEGER NOT NULL DEFAULT 5,
  usage_remaining INTEGER NOT NULL DEFAULT 5,
  timeout_seconds INTEGER NOT NULL DEFAULT 90,
  is_manual_seed INTEGER NOT NULL DEFAULT 0 CHECK (is_manual_seed IN (0, 1)),
  command_key TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  CONSTRAINT explore_state_recipes_target_key UNIQUE (target_id, command_key)
);

CREATE INDEX explore_state_recipes_target_idx ON "__SCHEMA__".explore_state_recipes (target_id, created_at);
CREATE INDEX explore_state_recipes_status_idx ON "__SCHEMA__".explore_state_recipes (target_id, status);

CREATE TABLE "__SCHEMA__".explore_states (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  target_account_id UUID NOT NULL REFERENCES "__SCHEMA__".target_accounts(id) ON DELETE RESTRICT,
  job_id UUID REFERENCES "__SCHEMA__".map_jobs(id) ON DELETE SET NULL,
  run_id UUID REFERENCES "__SCHEMA__".runs(id) ON DELETE SET NULL,
  page_key TEXT NOT NULL,
  view_state_key TEXT NOT NULL,
  presentation_state_key TEXT NOT NULL,
  state_rule_version INTEGER NOT NULL DEFAULT 1,
  readiness TEXT NOT NULL CHECK (readiness IN ('ready', 'ambiguous', 'unknown')),
  snapshot_json JSONB NOT NULL,
  evidence_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX explore_states_pres_idx ON "__SCHEMA__".explore_states (target_id, presentation_state_key);
CREATE INDEX explore_states_page_idx ON "__SCHEMA__".explore_states (target_id, page_key);
CREATE INDEX explore_states_job_idx ON "__SCHEMA__".explore_states (job_id);

CREATE TABLE "__SCHEMA__".explore_discoveries (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES "__SCHEMA__".map_jobs(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  step_run_id UUID,
  attempt_id UUID,
  source_explore_state_id UUID REFERENCES "__SCHEMA__".explore_states(id) ON DELETE SET NULL,
  source_presentation_state_key TEXT NOT NULL,
  control_fingerprint TEXT NOT NULL,
  accessible_name TEXT NOT NULL,
  role TEXT NOT NULL,
  ancestor_path_json JSONB NOT NULL,
  frame_selector TEXT NOT NULL DEFAULT '',
  candidate_category TEXT NOT NULL CHECK (candidate_category IN ('explicit_url', 'reveal', 'opaque_navigation')),
  target_url TEXT,
  target_digest TEXT,
  target_hint TEXT NOT NULL,
  locator_descriptor_json JSONB,
  collector_version TEXT NOT NULL,
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('complete', 'partial', 'missing')),
  rejection_reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('discovered', 'pending_review', 'approved', 'rejected', 'executed', 'invalidated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT explore_discoveries_job_ctrl UNIQUE (job_id, control_fingerprint)
);

CREATE INDEX explore_discoveries_target_idx ON "__SCHEMA__".explore_discoveries (target_id, created_at);
CREATE INDEX explore_discoveries_job_idx ON "__SCHEMA__".explore_discoveries (job_id, status);

CREATE TABLE "__SCHEMA__".explore_reviews (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES "__SCHEMA__".map_jobs(id) ON DELETE RESTRICT,
  explore_discovery_id UUID NOT NULL REFERENCES "__SCHEMA__".explore_discoveries(id) ON DELETE RESTRICT,
  reviewer_id UUID NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  expected_revision INTEGER NOT NULL,
  action_category TEXT NOT NULL CHECK (action_category IN ('direct_url_open', 'reveal', 'ui_activate')),
  security_basis TEXT NOT NULL,
  allowed_route_pattern TEXT,
  request_envelope_json JSONB,
  exact_target_url TEXT,
  dispatch_quota INTEGER NOT NULL DEFAULT 1,
  quota_remaining INTEGER NOT NULL DEFAULT 1,
  valid_until TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT explore_reviews_cmd_key UNIQUE (target_id, idempotency_key)
);

CREATE INDEX explore_reviews_disc_idx ON "__SCHEMA__".explore_reviews (explore_discovery_id);
CREATE INDEX explore_reviews_target_idx ON "__SCHEMA__".explore_reviews (target_id, created_at);

CREATE TABLE "__SCHEMA__".explore_traversals (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL REFERENCES "__SCHEMA__".map_jobs(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  attempt_id UUID,
  explore_discovery_id UUID REFERENCES "__SCHEMA__".explore_discoveries(id) ON DELETE SET NULL,
  explore_review_id UUID REFERENCES "__SCHEMA__".explore_reviews(id) ON DELETE SET NULL,
  action_category TEXT NOT NULL CHECK (action_category IN ('direct_url_open', 'reveal', 'ui_activate')),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('link_observed', 'reveals_navigation', 'ui_activate')),
  from_explore_state_id UUID REFERENCES "__SCHEMA__".explore_states(id) ON DELETE SET NULL,
  from_presentation_state_key TEXT NOT NULL,
  to_explore_state_id UUID REFERENCES "__SCHEMA__".explore_states(id) ON DELETE SET NULL,
  to_presentation_state_key TEXT,
  guard_decision TEXT NOT NULL CHECK (guard_decision IN ('allow', 'skip', 'stop')),
  guard_reason TEXT NOT NULL,
  action_outcome TEXT NOT NULL CHECK (action_outcome IN ('completed', 'failed', 'unknown', 'not_dispatched')),
  location_verify TEXT NOT NULL CHECK (location_verify IN ('support', 'deny', 'unknown')),
  action_verify TEXT NOT NULL CHECK (action_verify IN ('support', 'deny', 'unknown')),
  page_change_verify TEXT NOT NULL CHECK (page_change_verify IN ('support', 'deny', 'unknown')),
  business_result TEXT NOT NULL DEFAULT 'unknown',
  promoted INTEGER NOT NULL DEFAULT 0 CHECK (promoted = 0),
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('complete', 'partial', 'missing')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX explore_traversals_target_idx ON "__SCHEMA__".explore_traversals (target_id, created_at);
CREATE INDEX explore_traversals_job_idx ON "__SCHEMA__".explore_traversals (job_id);
CREATE INDEX explore_traversals_disc_idx ON "__SCHEMA__".explore_traversals (explore_discovery_id);

CREATE TABLE "__SCHEMA__".explore_entry_request_profiles (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  map_safe_entry_id UUID NOT NULL REFERENCES "__SCHEMA__".map_safe_entries(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  entry_url TEXT NOT NULL,
  profile_json JSONB NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT explore_entry_request_profiles_entry UNIQUE (target_id, map_safe_entry_id)
);

CREATE TABLE "__SCHEMA__".target_state_rules (
  target_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  rule_version INTEGER NOT NULL CHECK (rule_version >= 1),
  rules_json JSONB NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
