-- 0119：AP-0 动作事实补正。0116 曾在占位阶段被执行，执行过占位的库缺表缺列；
-- 本增量幂等重放 0116 的结构，并补：无账号 Run 的路径观察、动作后页面观察、Target 级采集开关。

ALTER TABLE "__SCHEMA__".scenario_ai_calls
  ADD COLUMN IF NOT EXISTS intent TEXT,
  ADD COLUMN IF NOT EXISTS route TEXT;

CREATE INDEX IF NOT EXISTS scenario_ai_calls_run_idx
  ON "__SCHEMA__".scenario_ai_calls (run_id);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".ai_task_events (
  id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL REFERENCES "__SCHEMA__".attempts(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  step_run_id UUID NOT NULL REFERENCES "__SCHEMA__".step_runs(id) ON DELETE RESTRICT,
  agent_instance_id TEXT NOT NULL,
  ordinal INT NOT NULL,
  phase TEXT NOT NULL,
  source TEXT NOT NULL,
  action_name TEXT NOT NULL,
  sdk_version TEXT NOT NULL,
  element_description TEXT,
  binding_json JSONB NOT NULL,
  value_provenance_json JSONB NOT NULL,
  params_summary_json JSONB,
  page_before_json JSONB NOT NULL,
  page_after_json JSONB,
  write_signal_count INT NOT NULL DEFAULT 0,
  write_signal_paths_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_ms INT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "__SCHEMA__".ai_task_events
  ADD COLUMN IF NOT EXISTS page_after_json JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS ai_task_events_dedup_idx
  ON "__SCHEMA__".ai_task_events (attempt_id, agent_instance_id, ordinal, phase);

CREATE INDEX IF NOT EXISTS ai_task_events_attempt_ordinal_idx
  ON "__SCHEMA__".ai_task_events (attempt_id, ordinal);

CREATE INDEX IF NOT EXISTS ai_task_events_run_idx
  ON "__SCHEMA__".ai_task_events (run_id);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".ai_path_observations (
  attempt_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".attempts(id) ON DELETE RESTRICT,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  step_run_id UUID NOT NULL REFERENCES "__SCHEMA__".step_runs(id) ON DELETE RESTRICT,
  step_id UUID NOT NULL,
  scenario_id UUID NOT NULL,
  scenario_version INT,
  target_id UUID NOT NULL,
  target_account_id UUID,
  step_definition_digest TEXT NOT NULL,
  namespace_digest TEXT NOT NULL,
  signature TEXT,
  action_count INT NOT NULL DEFAULT 0,
  solidifiable_level TEXT NOT NULL,
  solidifiable_reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  trace_integrity TEXT NOT NULL,
  model_calls INT NOT NULL DEFAULT 0,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  step_result TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "__SCHEMA__".ai_path_observations
  ALTER COLUMN target_account_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS ai_path_observations_scenario_step_idx
  ON "__SCHEMA__".ai_path_observations (scenario_id, step_id, recorded_at);

CREATE INDEX IF NOT EXISTS ai_path_observations_namespace_idx
  ON "__SCHEMA__".ai_path_observations (namespace_digest, recorded_at);

CREATE INDEX IF NOT EXISTS ai_path_observations_run_idx
  ON "__SCHEMA__".ai_path_observations (run_id);

-- Target 级采集开关：NULL 表示沿用平台配置，'off' 表示该目标系统不采集 AI 动作事实。
ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN IF NOT EXISTS ai_action_trace TEXT;
