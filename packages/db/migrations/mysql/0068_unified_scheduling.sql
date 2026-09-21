-- 0084 的 MySQL 等价增量：统一定时调度扩展四类消费者、间隔规则与知识分析作业。

ALTER TABLE schedules
  MODIFY target_account_id VARCHAR(36) NULL,
  ADD COLUMN name VARCHAR(120) NULL,
  ADD COLUMN identity_guard VARCHAR(512) NULL;

UPDATE schedules
   SET identity_guard = CONCAT('map_refresh:', target_account_id)
 WHERE enabled = 1
   AND consumer_key = 'map_refresh'
   AND target_account_id IS NOT NULL;

CREATE INDEX schedules_account_idx ON schedules (target_account_id);
ALTER TABLE schedules DROP INDEX schedules_account_consumer;
CREATE UNIQUE INDEX schedules_identity_guard ON schedules (identity_guard);
CREATE INDEX schedules_consumer_idx ON schedules (consumer_key, enabled);

ALTER TABLE schedule_versions
  ADD COLUMN name VARCHAR(120) NULL,
  ADD COLUMN time_rule JSON NULL,
  ADD COLUMN effective_at DATETIME(3) NULL,
  ADD COLUMN expires_at DATETIME(3) NULL;

UPDATE schedule_versions
   SET time_rule = JSON_OBJECT(
     'kind', 'calendar',
     'timezone', timezone,
     'weekdays', weekdays,
     'windows', JSON_ARRAY(JSON_OBJECT(
       'ruleId', 'default',
       'windowStart', window_start,
       'windowEnd', window_end
     )),
     'misfire', misfire
   )
 WHERE time_rule IS NULL;

ALTER TABLE schedule_occurrences
  ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'scheduled',
  ADD COLUMN rule_id VARCHAR(64) NULL,
  ADD COLUMN run_id VARCHAR(36) NULL,
  ADD COLUMN suite_run_id VARCHAR(36) NULL,
  ADD COLUMN analysis_job_id VARCHAR(36) NULL,
  ADD CONSTRAINT schedule_occurrences_run_fk FOREIGN KEY (run_id) REFERENCES runs(id),
  ADD CONSTRAINT schedule_occurrences_suite_fk FOREIGN KEY (suite_run_id) REFERENCES suite_runs(id);

UPDATE schedule_occurrences SET rule_id = 'default' WHERE rule_id IS NULL;

CREATE UNIQUE INDEX schedule_occurrences_run ON schedule_occurrences (run_id);
CREATE UNIQUE INDEX schedule_occurrences_suite ON schedule_occurrences (suite_run_id);
CREATE UNIQUE INDEX schedule_occurrences_analysis ON schedule_occurrences (analysis_job_id);
CREATE INDEX schedule_occurrences_pending_idx ON schedule_occurrences (admission_status, created_at);

CREATE TABLE analysis_jobs (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  schedule_id VARCHAR(36) NULL,
  occurrence_id VARCHAR(36) NULL,
  mode VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  source_scope JSON NOT NULL,
  strategy_version VARCHAR(64) NOT NULL,
  budget JSON NOT NULL,
  after_seq INT NOT NULL DEFAULT 0,
  through_seq INT NULL,
  checkpoint_seq INT NOT NULL DEFAULT 0,
  result JSON NULL,
  coverage_gaps JSON NOT NULL,
  model_usage JSON NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  fencing_token INT NOT NULL DEFAULT 0,
  lease_owner VARCHAR(128) NULL,
  lease_expires_at DATETIME(3) NULL,
  next_retry_at DATETIME(3) NULL,
  cancel_requested_at DATETIME(3) NULL,
  authorized_actor_id VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT analysis_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT analysis_jobs_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT analysis_jobs_schedule_fk FOREIGN KEY (schedule_id) REFERENCES schedules(id),
  CONSTRAINT analysis_jobs_occurrence_fk FOREIGN KEY (occurrence_id) REFERENCES schedule_occurrences(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX analysis_jobs_claim_idx ON analysis_jobs (status, next_retry_at, created_at);
CREATE INDEX analysis_jobs_target_idx ON analysis_jobs (target_id, created_at);
CREATE UNIQUE INDEX analysis_jobs_occurrence ON analysis_jobs (occurrence_id);

CREATE TABLE analysis_job_attempts (
  id VARCHAR(36) NOT NULL,
  job_id VARCHAR(36) NOT NULL,
  attempt_no INT NOT NULL,
  status VARCHAR(32) NOT NULL,
  fencing_token INT NOT NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  error TEXT NULL,
  CONSTRAINT analysis_job_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT analysis_job_attempts_job_fk FOREIGN KEY (job_id) REFERENCES analysis_jobs(id),
  CONSTRAINT analysis_job_attempts_no UNIQUE (job_id, attempt_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE analysis_job_events (
  id VARCHAR(36) NOT NULL,
  job_id VARCHAR(36) NOT NULL,
  seq INT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT analysis_job_events_pkey PRIMARY KEY (id),
  CONSTRAINT analysis_job_events_job_fk FOREIGN KEY (job_id) REFERENCES analysis_jobs(id),
  CONSTRAINT analysis_job_events_seq UNIQUE (job_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE analysis_checkpoints (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  scope_digest VARCHAR(256) NOT NULL,
  strategy_generation VARCHAR(64) NOT NULL,
  cursor_seq INT NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT analysis_checkpoints_pkey PRIMARY KEY (id),
  CONSTRAINT analysis_checkpoints_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT analysis_checkpoints_scope UNIQUE (target_id, scope_digest, strategy_generation)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE analysis_commit_seq (
  target_id VARCHAR(36) NOT NULL,
  seq INT NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT analysis_commit_seq_pkey PRIMARY KEY (target_id),
  CONSTRAINT analysis_commit_seq_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE analysis_source_index (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(36) NOT NULL,
  source_revision INT NOT NULL DEFAULT 1,
  committed_seq INT NOT NULL,
  run_id VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT analysis_source_index_pkey PRIMARY KEY (id),
  CONSTRAINT analysis_source_index_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT analysis_source_index_run_fk FOREIGN KEY (run_id) REFERENCES runs(id),
  CONSTRAINT analysis_source_index_unique UNIQUE (source_type, source_id, source_revision),
  CONSTRAINT analysis_source_index_seq UNIQUE (target_id, committed_seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX analysis_source_index_target ON analysis_source_index (target_id, committed_seq);

CREATE TABLE analysis_candidates (
  id VARCHAR(36) NOT NULL,
  job_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  title VARCHAR(200) NOT NULL,
  summary VARCHAR(2000) NOT NULL,
  payload JSON NOT NULL,
  sources JSON NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT analysis_candidates_pkey PRIMARY KEY (id),
  CONSTRAINT analysis_candidates_job_fk FOREIGN KEY (job_id) REFERENCES analysis_jobs(id),
  CONSTRAINT analysis_candidates_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX analysis_candidates_job ON analysis_candidates (job_id, created_at);

CREATE TABLE analysis_commands (
  id VARCHAR(36) NOT NULL,
  command_key VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT analysis_commands_pkey PRIMARY KEY (id),
  CONSTRAINT analysis_commands_key UNIQUE (command_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

INSERT INTO console_role_permissions (console_role_id, permission)
SELECT r.id, 'map:analyze'
FROM console_roles r
WHERE r.kind = 'system' AND r.key = 'admin'
ON DUPLICATE KEY UPDATE permission = permission;
