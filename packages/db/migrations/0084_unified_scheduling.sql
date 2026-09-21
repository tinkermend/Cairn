-- 0084：统一定时调度扩展四类消费者、间隔规则与知识分析作业。

ALTER TABLE "__SCHEMA__".schedules
  ALTER COLUMN target_account_id DROP NOT NULL,
  ADD COLUMN name TEXT,
  ADD COLUMN identity_guard TEXT;

UPDATE "__SCHEMA__".schedules
   SET identity_guard = 'map_refresh:' || target_account_id::text
 WHERE enabled = 1
   AND consumer_key = 'map_refresh'
   AND target_account_id IS NOT NULL;

DROP INDEX IF EXISTS "__SCHEMA__".schedules_account_consumer;
CREATE UNIQUE INDEX schedules_identity_guard
  ON "__SCHEMA__".schedules (identity_guard);
CREATE INDEX schedules_consumer_idx
  ON "__SCHEMA__".schedules (consumer_key, enabled);

ALTER TABLE "__SCHEMA__".schedule_versions
  ADD COLUMN name TEXT,
  ADD COLUMN time_rule JSONB,
  ADD COLUMN effective_at TIMESTAMPTZ,
  ADD COLUMN expires_at TIMESTAMPTZ;

UPDATE "__SCHEMA__".schedule_versions
   SET time_rule = jsonb_build_object(
     'kind', 'calendar',
     'timezone', timezone,
     'weekdays', weekdays,
     'windows', jsonb_build_array(jsonb_build_object(
       'ruleId', 'default',
       'windowStart', window_start,
       'windowEnd', window_end
     )),
     'misfire', misfire
   )
 WHERE time_rule IS NULL;

ALTER TABLE "__SCHEMA__".schedule_occurrences
  ADD COLUMN source TEXT NOT NULL DEFAULT 'scheduled',
  ADD COLUMN rule_id TEXT,
  ADD COLUMN run_id UUID REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  ADD COLUMN suite_run_id UUID REFERENCES "__SCHEMA__".suite_runs(id) ON DELETE RESTRICT,
  ADD COLUMN analysis_job_id UUID;

UPDATE "__SCHEMA__".schedule_occurrences
   SET rule_id = 'default'
 WHERE rule_id IS NULL;

CREATE UNIQUE INDEX schedule_occurrences_run ON "__SCHEMA__".schedule_occurrences (run_id);
CREATE UNIQUE INDEX schedule_occurrences_suite ON "__SCHEMA__".schedule_occurrences (suite_run_id);
CREATE UNIQUE INDEX schedule_occurrences_analysis ON "__SCHEMA__".schedule_occurrences (analysis_job_id);
CREATE INDEX schedule_occurrences_pending_idx ON "__SCHEMA__".schedule_occurrences (admission_status, created_at);

CREATE TABLE "__SCHEMA__".analysis_jobs (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  schedule_id UUID REFERENCES "__SCHEMA__".schedules(id) ON DELETE RESTRICT,
  occurrence_id UUID REFERENCES "__SCHEMA__".schedule_occurrences(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  source_scope JSONB NOT NULL,
  strategy_version TEXT NOT NULL,
  budget JSONB NOT NULL,
  after_seq INTEGER NOT NULL DEFAULT 0,
  through_seq INTEGER,
  checkpoint_seq INTEGER NOT NULL DEFAULT 0,
  result JSONB,
  coverage_gaps JSONB NOT NULL,
  model_usage JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  authorized_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analysis_jobs_claim_idx ON "__SCHEMA__".analysis_jobs (status, next_retry_at, created_at);
CREATE INDEX analysis_jobs_target_idx ON "__SCHEMA__".analysis_jobs (target_id, created_at);
CREATE UNIQUE INDEX analysis_jobs_occurrence ON "__SCHEMA__".analysis_jobs (occurrence_id);

CREATE TABLE "__SCHEMA__".analysis_job_attempts (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES "__SCHEMA__".analysis_jobs(id) ON DELETE RESTRICT,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  CONSTRAINT analysis_job_attempts_no UNIQUE (job_id, attempt_no)
);

CREATE TABLE "__SCHEMA__".analysis_job_events (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES "__SCHEMA__".analysis_jobs(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT analysis_job_events_seq UNIQUE (job_id, seq)
);

CREATE TABLE "__SCHEMA__".analysis_checkpoints (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  scope_digest TEXT NOT NULL,
  strategy_generation TEXT NOT NULL,
  cursor_seq INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT analysis_checkpoints_scope UNIQUE (target_id, scope_digest, strategy_generation)
);

CREATE TABLE "__SCHEMA__".analysis_commit_seq (
  target_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "__SCHEMA__".analysis_source_index (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  source_revision INTEGER NOT NULL DEFAULT 1,
  committed_seq INTEGER NOT NULL,
  run_id UUID REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT analysis_source_index_unique UNIQUE (source_type, source_id, source_revision),
  CONSTRAINT analysis_source_index_seq UNIQUE (target_id, committed_seq)
);
CREATE INDEX analysis_source_index_target ON "__SCHEMA__".analysis_source_index (target_id, committed_seq);

CREATE TABLE "__SCHEMA__".analysis_candidates (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES "__SCHEMA__".analysis_jobs(id) ON DELETE RESTRICT,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload JSONB NOT NULL,
  sources JSONB NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analysis_candidates_job ON "__SCHEMA__".analysis_candidates (job_id, created_at);

CREATE TABLE "__SCHEMA__".analysis_commands (
  id UUID PRIMARY KEY,
  command_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT analysis_commands_key UNIQUE (command_key)
);

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, 'map:analyze'
FROM "__SCHEMA__".console_roles r
WHERE r.kind = 'system' AND r.key = 'admin'
ON CONFLICT DO NOTHING;
