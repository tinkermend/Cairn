-- 0046 的 SQLite 等价增量：运行消费政策、资格、冻结引用与选择记录。

CREATE TABLE map_consumption_policies (
  target_id TEXT NOT NULL,
  policy_schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  consumption_mode TEXT NOT NULL CHECK (consumption_mode IN ('off','shadow','read_only_fallback')),
  allowed_step_types TEXT NOT NULL,
  allowed_asset_refs TEXT NOT NULL,
  max_candidate_count INTEGER NOT NULL CHECK (max_candidate_count BETWEEN 1 AND 5),
  max_resolve_ms INTEGER NOT NULL CHECK (max_resolve_ms BETWEEN 1 AND 5000),
  max_extra_ai_calls INTEGER NOT NULL CHECK (max_extra_ai_calls = 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_consumption_policies_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_consumption_policies_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE map_consumption_eligibility (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  eligibility_report_key TEXT NOT NULL,
  eligible_step_types TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_consumption_eligibility_pkey PRIMARY KEY (id),
  CONSTRAINT map_consumption_eligibility_target_report UNIQUE (target_id, eligibility_report_key),
  CONSTRAINT map_consumption_eligibility_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);
CREATE INDEX map_consumption_eligibility_target_idx ON map_consumption_eligibility (target_id, recorded_at);

CREATE TABLE map_consumption_policy_commands (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  command_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_consumption_policy_commands_pkey PRIMARY KEY (id),
  CONSTRAINT map_consumption_policy_commands_key UNIQUE (target_id, command_key),
  CONSTRAINT map_consumption_policy_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE map_run_release_refs (
  run_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  source_watermark INTEGER NOT NULL,
  consumer_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_run_release_refs_pkey PRIMARY KEY (run_id),
  CONSTRAINT map_run_release_refs_run_fk FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  CONSTRAINT map_run_release_refs_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT map_run_release_refs_release_fk FOREIGN KEY (release_id) REFERENCES map_releases(id) ON DELETE RESTRICT
);
CREATE INDEX map_run_release_refs_target_idx ON map_run_release_refs (target_id, release_id);

CREATE TABLE map_selection_decisions (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  decision_ordinal INTEGER NOT NULL CHECK (decision_ordinal >= 0),
  release_id TEXT,
  manifest_digest TEXT,
  policy_version INTEGER,
  consumer_version TEXT,
  asset_ref_key TEXT,
  object_id TEXT,
  implementation_key TEXT,
  descriptor_version INTEGER,
  condition_snapshot TEXT,
  coverage TEXT,
  baseline_outcome TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  selected_descriptor_version INTEGER,
  selected_descriptor_digest TEXT,
  consumption_mode TEXT NOT NULL CHECK (consumption_mode IN ('off','shadow','read_only_fallback')),
  decision_kind TEXT NOT NULL CHECK (decision_kind IN ('baseline','shadow_only','selected','skipped','blocked')),
  reason_code TEXT NOT NULL,
  spent_ms INTEGER NOT NULL CHECK (spent_ms >= 0),
  extra_ai_calls INTEGER NOT NULL CHECK (extra_ai_calls = 0),
  evidence_refs TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_selection_decisions_pkey PRIMARY KEY (id),
  CONSTRAINT map_selection_decisions_attempt_ord UNIQUE (attempt_id, decision_ordinal),
  CONSTRAINT map_selection_decisions_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT map_selection_decisions_run_fk FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  CONSTRAINT map_selection_decisions_step_fk FOREIGN KEY (step_run_id) REFERENCES step_runs(id) ON DELETE RESTRICT,
  CONSTRAINT map_selection_decisions_attempt_fk FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE RESTRICT
);
CREATE INDEX map_selection_decisions_run_idx ON map_selection_decisions (run_id, step_run_id, created_at);
