-- 0122：通用报告触发器、服务主体支持与输出策略（report_triggers; reports/revisions/export_jobs/artifacts.service_caller_id; scenario_report_defaults/run_report_contexts.output_policy）

ALTER TABLE "__SCHEMA__".reports
  ALTER COLUMN created_by_console_account_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS service_caller_id UUID REFERENCES "__SCHEMA__".service_callers(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS reports_idempotency_service_idx
  ON "__SCHEMA__".reports (service_caller_id, idempotency_key);

ALTER TABLE "__SCHEMA__".report_revisions
  ALTER COLUMN created_by_console_account_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS service_caller_id UUID REFERENCES "__SCHEMA__".service_callers(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS report_revisions_idempotency_service_idx
  ON "__SCHEMA__".report_revisions (service_caller_id, idempotency_key);

ALTER TABLE "__SCHEMA__".export_jobs
  ALTER COLUMN created_by_console_account_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS service_caller_id UUID REFERENCES "__SCHEMA__".service_callers(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS export_jobs_idempotency_service_idx
  ON "__SCHEMA__".export_jobs (service_caller_id, idempotency_key);

ALTER TABLE "__SCHEMA__".artifacts
  ADD COLUMN IF NOT EXISTS service_caller_id UUID REFERENCES "__SCHEMA__".service_callers(id) ON DELETE RESTRICT;

ALTER TABLE "__SCHEMA__".scenario_report_defaults
  ADD COLUMN IF NOT EXISTS output_policy JSONB;

ALTER TABLE "__SCHEMA__".run_report_contexts
  ADD COLUMN IF NOT EXISTS output_policy JSONB;

CREATE TABLE IF NOT EXISTS "__SCHEMA__".report_triggers (
  id UUID PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  report_id UUID REFERENCES "__SCHEMA__".reports(id) ON DELETE RESTRICT,
  reason TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS report_triggers_subject_idx
  ON "__SCHEMA__".report_triggers (subject_kind, subject_id);

CREATE INDEX IF NOT EXISTS report_triggers_pending_idx
  ON "__SCHEMA__".report_triggers (status, updated_at);
