-- 0046 的 MySQL 等价增量：运行消费政策、资格、冻结引用与选择记录。

CREATE TABLE map_consumption_policies (
  target_id VARCHAR(36) NOT NULL,
  policy_schema_version INT NOT NULL,
  policy_version INT NOT NULL,
  consumption_mode VARCHAR(32) NOT NULL,
  allowed_step_types JSON NOT NULL,
  allowed_asset_refs JSON NOT NULL,
  max_candidate_count INT NOT NULL,
  max_resolve_ms INT NOT NULL,
  max_extra_ai_calls INT NOT NULL,
  revision INT NOT NULL,
  updated_by VARCHAR(36) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_consumption_policies_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_consumption_policies_mode_check CHECK (consumption_mode IN ('off','shadow','read_only_fallback')),
  CONSTRAINT map_consumption_policies_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_consumption_eligibility (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  eligibility_report_key VARCHAR(128) NOT NULL,
  eligible_step_types JSON NOT NULL,
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_consumption_eligibility_pkey PRIMARY KEY (id),
  CONSTRAINT map_consumption_eligibility_target_report UNIQUE (target_id, eligibility_report_key),
  CONSTRAINT map_consumption_eligibility_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX map_consumption_eligibility_target_idx ON map_consumption_eligibility (target_id, recorded_at);

CREATE TABLE map_consumption_policy_commands (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  command_key VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_consumption_policy_commands_pkey PRIMARY KEY (id),
  CONSTRAINT map_consumption_policy_commands_key UNIQUE (target_id, command_key),
  CONSTRAINT map_consumption_policy_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_run_release_refs (
  run_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  release_id VARCHAR(36) NOT NULL,
  manifest_digest VARCHAR(64) NOT NULL,
  source_watermark BIGINT NOT NULL,
  consumer_version VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_run_release_refs_pkey PRIMARY KEY (run_id),
  CONSTRAINT map_run_release_refs_run_fk FOREIGN KEY (run_id) REFERENCES runs(id),
  CONSTRAINT map_run_release_refs_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT map_run_release_refs_release_fk FOREIGN KEY (release_id) REFERENCES map_releases(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX map_run_release_refs_target_idx ON map_run_release_refs (target_id, release_id);

CREATE TABLE map_selection_decisions (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  run_id VARCHAR(36) NOT NULL,
  step_run_id VARCHAR(36) NOT NULL,
  attempt_id VARCHAR(36) NOT NULL,
  decision_ordinal INT NOT NULL,
  release_id VARCHAR(36),
  manifest_digest VARCHAR(64),
  policy_version INT,
  consumer_version VARCHAR(64),
  asset_ref_key VARCHAR(192),
  object_id VARCHAR(36),
  implementation_key VARCHAR(192),
  descriptor_version INT,
  condition_snapshot JSON,
  coverage VARCHAR(64),
  baseline_outcome VARCHAR(64) NOT NULL,
  candidates_json JSON NOT NULL,
  selected_descriptor_version INT,
  selected_descriptor_digest VARCHAR(64),
  consumption_mode VARCHAR(32) NOT NULL,
  decision_kind VARCHAR(16) NOT NULL,
  reason_code VARCHAR(64) NOT NULL,
  spent_ms INT NOT NULL,
  extra_ai_calls INT NOT NULL,
  evidence_refs JSON NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_selection_decisions_pkey PRIMARY KEY (id),
  CONSTRAINT map_selection_decisions_kind_check CHECK (decision_kind IN ('baseline','shadow_only','selected','skipped','blocked')),
  CONSTRAINT map_selection_decisions_mode_check CHECK (consumption_mode IN ('off','shadow','read_only_fallback')),
  CONSTRAINT map_selection_decisions_attempt_ord UNIQUE (attempt_id, decision_ordinal),
  CONSTRAINT map_selection_decisions_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT map_selection_decisions_run_fk FOREIGN KEY (run_id) REFERENCES runs(id),
  CONSTRAINT map_selection_decisions_step_fk FOREIGN KEY (step_run_id) REFERENCES step_runs(id),
  CONSTRAINT map_selection_decisions_attempt_fk FOREIGN KEY (attempt_id) REFERENCES attempts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX map_selection_decisions_run_idx ON map_selection_decisions (run_id, step_run_id, created_at);
