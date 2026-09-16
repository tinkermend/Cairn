-- 0046：Target 运行消费政策、T 资格、Run 冻结引用与选择记录。

CREATE TABLE "__SCHEMA__".map_consumption_policies (
  target_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  policy_schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  consumption_mode TEXT NOT NULL,
  allowed_step_types JSONB NOT NULL,
  allowed_asset_refs JSONB NOT NULL,
  max_candidate_count INTEGER NOT NULL CHECK (max_candidate_count BETWEEN 1 AND 5),
  max_resolve_ms INTEGER NOT NULL CHECK (max_resolve_ms BETWEEN 1 AND 5000),
  max_extra_ai_calls INTEGER NOT NULL CHECK (max_extra_ai_calls = 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_consumption_policies_mode_check
    CHECK (consumption_mode IN ('off','shadow','read_only_fallback'))
);

CREATE TABLE "__SCHEMA__".map_consumption_eligibility (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  eligibility_report_key TEXT NOT NULL,
  eligible_step_types JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_consumption_eligibility_target_report UNIQUE (target_id, eligibility_report_key)
);
CREATE INDEX map_consumption_eligibility_target_idx
  ON "__SCHEMA__".map_consumption_eligibility (target_id, recorded_at DESC);

CREATE TABLE "__SCHEMA__".map_consumption_policy_commands (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  command_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_consumption_policy_commands_key UNIQUE (target_id, command_key)
);

CREATE TABLE "__SCHEMA__".map_run_release_refs (
  run_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  release_id UUID NOT NULL REFERENCES "__SCHEMA__".map_releases(id) ON DELETE RESTRICT,
  manifest_digest TEXT NOT NULL,
  source_watermark BIGINT NOT NULL,
  consumer_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX map_run_release_refs_target_idx
  ON "__SCHEMA__".map_run_release_refs (target_id, release_id);

CREATE TABLE "__SCHEMA__".map_selection_decisions (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  step_run_id UUID NOT NULL REFERENCES "__SCHEMA__".step_runs(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES "__SCHEMA__".attempts(id) ON DELETE RESTRICT,
  decision_ordinal INTEGER NOT NULL CHECK (decision_ordinal >= 0),
  release_id UUID,
  manifest_digest TEXT,
  policy_version INTEGER,
  consumer_version TEXT,
  asset_ref_key TEXT,
  object_id UUID,
  implementation_key TEXT,
  descriptor_version INTEGER,
  condition_snapshot JSONB,
  coverage TEXT,
  baseline_outcome TEXT NOT NULL,
  candidates_json JSONB NOT NULL,
  selected_descriptor_version INTEGER,
  selected_descriptor_digest TEXT,
  consumption_mode TEXT NOT NULL,
  decision_kind TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  spent_ms INTEGER NOT NULL CHECK (spent_ms >= 0),
  extra_ai_calls INTEGER NOT NULL CHECK (extra_ai_calls = 0),
  evidence_refs JSONB NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_selection_decisions_kind_check
    CHECK (decision_kind IN ('baseline','shadow_only','selected','skipped','blocked')),
  CONSTRAINT map_selection_decisions_mode_check
    CHECK (consumption_mode IN ('off','shadow','read_only_fallback')),
  CONSTRAINT map_selection_decisions_attempt_ord UNIQUE (attempt_id, decision_ordinal)
);
CREATE INDEX map_selection_decisions_run_idx
  ON "__SCHEMA__".map_selection_decisions (run_id, step_run_id, created_at);
