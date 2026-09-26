-- PostgreSQL 0116 的 MySQL 等价增量：AP-0 AI 动作事实、路径观察与调用意图归因。

ALTER TABLE scenario_ai_calls
  ADD COLUMN intent VARCHAR(32) NULL,
  ADD COLUMN route VARCHAR(16) NULL;

CREATE INDEX scenario_ai_calls_run_idx ON scenario_ai_calls (run_id);

CREATE TABLE ai_task_events (
  id VARCHAR(36) NOT NULL,
  attempt_id VARCHAR(36) NOT NULL,
  run_id VARCHAR(36) NOT NULL,
  step_run_id VARCHAR(36) NOT NULL,
  agent_instance_id VARCHAR(64) NOT NULL,
  ordinal INT NOT NULL,
  phase VARCHAR(16) NOT NULL,
  source VARCHAR(32) NOT NULL,
  action_name VARCHAR(64) NOT NULL,
  sdk_version VARCHAR(64) NOT NULL,
  element_description TEXT NULL,
  binding_json JSON NOT NULL,
  value_provenance_json JSON NOT NULL,
  params_summary_json JSON NULL,
  page_before_json JSON NOT NULL,
  write_signal_count INT NOT NULL DEFAULT 0,
  write_signal_paths_json JSON NOT NULL,
  duration_ms INT NULL,
  error_code VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT ai_task_events_pkey PRIMARY KEY (id),
  CONSTRAINT ai_task_events_attempt_fk FOREIGN KEY (attempt_id) REFERENCES attempts(id),
  CONSTRAINT ai_task_events_run_fk FOREIGN KEY (run_id) REFERENCES runs(id),
  CONSTRAINT ai_task_events_step_run_fk FOREIGN KEY (step_run_id) REFERENCES step_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX ai_task_events_dedup_idx ON ai_task_events (attempt_id, agent_instance_id, ordinal, phase);
CREATE INDEX ai_task_events_attempt_ordinal_idx ON ai_task_events (attempt_id, ordinal);
CREATE INDEX ai_task_events_run_idx ON ai_task_events (run_id);

CREATE TABLE ai_path_observations (
  attempt_id VARCHAR(36) NOT NULL,
  run_id VARCHAR(36) NOT NULL,
  step_run_id VARCHAR(36) NOT NULL,
  step_id VARCHAR(36) NOT NULL,
  scenario_id VARCHAR(36) NOT NULL,
  scenario_version INT NULL,
  target_id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36) NOT NULL,
  step_definition_digest VARCHAR(64) NOT NULL,
  namespace_digest VARCHAR(64) NOT NULL,
  signature VARCHAR(64) NULL,
  action_count INT NOT NULL DEFAULT 0,
  solidifiable_level VARCHAR(16) NOT NULL,
  solidifiable_reasons_json JSON NOT NULL,
  trace_integrity VARCHAR(16) NOT NULL,
  model_calls INT NOT NULL DEFAULT 0,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  step_result VARCHAR(16) NOT NULL,
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT ai_path_observations_pkey PRIMARY KEY (attempt_id),
  CONSTRAINT ai_path_observations_attempt_fk FOREIGN KEY (attempt_id) REFERENCES attempts(id),
  CONSTRAINT ai_path_observations_run_fk FOREIGN KEY (run_id) REFERENCES runs(id),
  CONSTRAINT ai_path_observations_step_run_fk FOREIGN KEY (step_run_id) REFERENCES step_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX ai_path_observations_scenario_step_idx ON ai_path_observations (scenario_id, step_id, recorded_at);
CREATE INDEX ai_path_observations_namespace_idx ON ai_path_observations (namespace_digest, recorded_at);
CREATE INDEX ai_path_observations_run_idx ON ai_path_observations (run_id);
