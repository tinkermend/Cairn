-- 0062 的 MySQL 等价增量：Worker 心跳采样、API 实例、对象存储探测、L4 采样与 Scenario AI 账本。

ALTER TABLE workers
  ADD COLUMN sampled_rss_bytes BIGINT NULL,
  ADD COLUMN sampled_event_loop_delay_ms DOUBLE NULL,
  ADD COLUMN sampled_cpu_percent INT NULL,
  ADD COLUMN sampled_profile_bytes BIGINT NULL,
  ADD COLUMN sampled_profile_count INT NULL,
  ADD COLUMN sampled_profile_disk_free_bytes BIGINT NULL,
  ADD COLUMN sampled_midscene_bytes BIGINT NULL,
  ADD COLUMN sampled_browser_process_count INT NULL,
  ADD COLUMN process_clock_skew_ms INT NULL,
  ADD COLUMN sampled_disk_at DATETIME(3) NULL;

CREATE TABLE api_instances (
  id VARCHAR(256) NOT NULL,
  instance_id VARCHAR(36) NOT NULL,
  id_source VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  heartbeat_at DATETIME(3) NOT NULL,
  heartbeat_expires_at DATETIME(3) NULL,
  lost_after_seconds INT NULL,
  version VARCHAR(128) NULL,
  schema_logical_version VARCHAR(32) NULL,
  sampled_rss_bytes BIGINT NULL,
  sampled_event_loop_delay_ms DOUBLE NULL,
  sampled_sse_connections INT NULL,
  sampled_internal_forward_in_flight INT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  stopped_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  CONSTRAINT api_instances_id_source_check CHECK (id_source IN ('configured', 'derived')),
  CONSTRAINT api_instances_status_check CHECK (status IN ('READY', 'DRAINING', 'STOPPED', 'LOST')),
  CONSTRAINT api_instances_lost_after_seconds_check CHECK ((lost_after_seconds IS NULL) OR (lost_after_seconds >= 1))
);

CREATE INDEX api_instances_expire_idx ON api_instances (status, heartbeat_expires_at);

CREATE TABLE object_store_probes (
  store_kind VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  latency_ms INT NULL,
  error_class VARCHAR(64) NULL,
  probed_at DATETIME(3) NOT NULL,
  probed_by VARCHAR(288) NOT NULL,
  PRIMARY KEY (store_kind),
  CONSTRAINT object_store_probes_status_check CHECK (status IN ('ok', 'failed'))
);

CREATE TABLE monitor_samples (
  metric_key VARCHAR(128) NOT NULL,
  scope VARCHAR(16) NOT NULL,
  scope_id VARCHAR(256) NOT NULL,
  bucket_at DATETIME(3) NOT NULL,
  value DOUBLE NOT NULL,
  PRIMARY KEY (metric_key, scope, scope_id, bucket_at),
  CONSTRAINT monitor_samples_scope_check CHECK (scope IN ('platform', 'api', 'worker'))
);

CREATE INDEX monitor_samples_bucket_idx ON monitor_samples (bucket_at);

CREATE TABLE scenario_ai_calls (
  id VARCHAR(36) NOT NULL,
  evidence_id VARCHAR(36) NOT NULL,
  run_id VARCHAR(36) NOT NULL,
  step_run_id VARCHAR(36) NOT NULL,
  attempt_id VARCHAR(36) NULL,
  purpose VARCHAR(32) NOT NULL,
  model VARCHAR(256) NULL,
  phase VARCHAR(16) NOT NULL,
  duration_ms INT NULL,
  input_tokens INT NULL,
  output_tokens INT NULL,
  cost DOUBLE NULL,
  error_code VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT scenario_ai_calls_phase_check CHECK (phase IN ('completed', 'failed')),
  CONSTRAINT scenario_ai_calls_evidence_unique UNIQUE (evidence_id)
);

CREATE INDEX scenario_ai_calls_created_idx ON scenario_ai_calls (created_at);
CREATE INDEX scenario_ai_calls_model_created_idx ON scenario_ai_calls (model, created_at);
