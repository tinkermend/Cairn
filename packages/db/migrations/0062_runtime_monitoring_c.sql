-- 0062：RM-C 采集补齐。Worker 心跳采样列、API 实例登记、对象存储探测、L4 采样与 Scenario AI 账本。
-- 新列初始为 null，禁止用 0 回填。

ALTER TABLE "__SCHEMA__".workers
  ADD COLUMN IF NOT EXISTS sampled_rss_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS sampled_event_loop_delay_ms DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS sampled_cpu_percent INT,
  ADD COLUMN IF NOT EXISTS sampled_profile_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS sampled_profile_count INT,
  ADD COLUMN IF NOT EXISTS sampled_profile_disk_free_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS sampled_midscene_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS sampled_browser_process_count INT,
  ADD COLUMN IF NOT EXISTS process_clock_skew_ms INT,
  ADD COLUMN IF NOT EXISTS sampled_disk_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS "__SCHEMA__".api_instances (
  id TEXT PRIMARY KEY,
  instance_id UUID NOT NULL,
  id_source TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL,
  heartbeat_expires_at TIMESTAMPTZ,
  lost_after_seconds INT,
  version TEXT,
  schema_logical_version TEXT,
  sampled_rss_bytes BIGINT,
  sampled_event_loop_delay_ms DOUBLE PRECISION,
  sampled_sse_connections INT,
  sampled_internal_forward_in_flight INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at TIMESTAMPTZ,
  CONSTRAINT api_instances_id_source_check CHECK (id_source IN ('configured', 'derived')),
  CONSTRAINT api_instances_status_check CHECK (status IN ('READY', 'DRAINING', 'STOPPED', 'LOST')),
  CONSTRAINT api_instances_lost_after_seconds_check CHECK (lost_after_seconds IS NULL OR lost_after_seconds >= 1)
);

CREATE INDEX IF NOT EXISTS api_instances_expire_idx
  ON "__SCHEMA__".api_instances (status, heartbeat_expires_at);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".object_store_probes (
  store_kind TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  latency_ms INT,
  error_class TEXT,
  probed_at TIMESTAMPTZ NOT NULL,
  probed_by TEXT NOT NULL,
  CONSTRAINT object_store_probes_status_check CHECK (status IN ('ok', 'failed'))
);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".monitor_samples (
  metric_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  bucket_at TIMESTAMPTZ NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (metric_key, scope, scope_id, bucket_at),
  CONSTRAINT monitor_samples_scope_check CHECK (scope IN ('platform', 'api', 'worker'))
);

CREATE INDEX IF NOT EXISTS monitor_samples_bucket_idx
  ON "__SCHEMA__".monitor_samples (bucket_at);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".scenario_ai_calls (
  id UUID PRIMARY KEY,
  evidence_id UUID NOT NULL,
  run_id UUID NOT NULL,
  step_run_id UUID NOT NULL,
  attempt_id UUID,
  purpose TEXT NOT NULL,
  model TEXT,
  phase TEXT NOT NULL,
  duration_ms INT,
  input_tokens INT,
  output_tokens INT,
  cost DOUBLE PRECISION,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scenario_ai_calls_phase_check CHECK (phase IN ('completed', 'failed')),
  CONSTRAINT scenario_ai_calls_evidence_unique UNIQUE (evidence_id)
);

CREATE INDEX IF NOT EXISTS scenario_ai_calls_created_idx
  ON "__SCHEMA__".scenario_ai_calls (created_at);

CREATE INDEX IF NOT EXISTS scenario_ai_calls_model_created_idx
  ON "__SCHEMA__".scenario_ai_calls (model, created_at);
