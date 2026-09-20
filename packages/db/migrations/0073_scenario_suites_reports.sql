-- 0073：场景集、报告修订、导出任务与对象账本独立归属。

ALTER TABLE "__SCHEMA__".runs
  ADD COLUMN execution_origin TEXT NOT NULL DEFAULT 'standalone',
  ADD COLUMN suite_run_id UUID,
  ADD COLUMN suite_member_id TEXT;

ALTER TABLE "__SCHEMA__".runs
  ADD CONSTRAINT runs_execution_origin_check CHECK (execution_origin IN ('standalone', 'suite_member'));

CREATE TABLE "__SCHEMA__".scenario_suites (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  deleted_at TIMESTAMPTZ,
  deleted_by JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT scenario_suites_status_check CHECK (status IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX scenario_suites_target_name_idx ON "__SCHEMA__".scenario_suites (target_id, name);
CREATE INDEX scenario_suites_target_id_idx ON "__SCHEMA__".scenario_suites (target_id);
CREATE INDEX scenario_suites_deleted_at_idx ON "__SCHEMA__".scenario_suites (deleted_at);

CREATE TABLE "__SCHEMA__".scenario_suite_drafts (
  suite_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".scenario_suites (id) ON DELETE RESTRICT,
  revision INT NOT NULL,
  document JSONB NOT NULL,
  updated_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT scenario_suite_drafts_revision_check CHECK (revision > 0)
);

CREATE TABLE "__SCHEMA__".scenario_suite_versions (
  id UUID PRIMARY KEY,
  suite_id UUID NOT NULL REFERENCES "__SCHEMA__".scenario_suites (id) ON DELETE RESTRICT,
  version_no INT NOT NULL,
  document JSONB NOT NULL,
  digest TEXT NOT NULL,
  published_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT scenario_suite_versions_no_check CHECK (version_no > 0)
);
CREATE UNIQUE INDEX scenario_suite_versions_no_idx ON "__SCHEMA__".scenario_suite_versions (suite_id, version_no);

CREATE TABLE "__SCHEMA__".scenario_suite_publish_receipts (
  actor_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  version_id UUID NOT NULL REFERENCES "__SCHEMA__".scenario_suite_versions (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (actor_id, idempotency_key)
);

CREATE TABLE "__SCHEMA__".suite_runs (
  id UUID PRIMARY KEY,
  suite_id UUID NOT NULL REFERENCES "__SCHEMA__".scenario_suites (id) ON DELETE RESTRICT,
  suite_version_id UUID NOT NULL REFERENCES "__SCHEMA__".scenario_suite_versions (id) ON DELETE RESTRICT,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  created_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  verdict TEXT,
  evidence_status TEXT NOT NULL DEFAULT 'PENDING',
  failure_policy TEXT NOT NULL,
  cancel_requested_at TIMESTAMPTZ,
  reason TEXT,
  deadline_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  snapshot JSONB NOT NULL,
  snapshot_digest TEXT NOT NULL,
  idempotency_key TEXT,
  idempotency_digest TEXT,
  revision INT NOT NULL DEFAULT 0,
  event_seq INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT suite_runs_status_check CHECK (status IN ('QUEUED', 'RUNNING', 'WAITING', 'NEEDS_REVIEW', 'COMPLETED', 'CANCELLED', 'FAILED')),
  CONSTRAINT suite_runs_failure_policy_check CHECK (failure_policy IN ('continue', 'stop'))
);
CREATE UNIQUE INDEX suite_runs_idempotency_idx ON "__SCHEMA__".suite_runs (created_by_console_account_id, idempotency_key);
CREATE INDEX suite_runs_target_created_idx ON "__SCHEMA__".suite_runs (target_id, created_at);
CREATE INDEX suite_runs_suite_created_idx ON "__SCHEMA__".suite_runs (suite_id, created_at);
CREATE INDEX suite_runs_status_idx ON "__SCHEMA__".suite_runs (status, updated_at);

ALTER TABLE "__SCHEMA__".runs
  ADD CONSTRAINT runs_suite_run_id_fkey FOREIGN KEY (suite_run_id) REFERENCES "__SCHEMA__".suite_runs (id) ON DELETE RESTRICT;
CREATE INDEX runs_suite_run_id_idx ON "__SCHEMA__".runs (suite_run_id);
CREATE INDEX runs_execution_origin_idx ON "__SCHEMA__".runs (execution_origin, created_at);

CREATE TABLE "__SCHEMA__".suite_run_items (
  id UUID PRIMARY KEY,
  suite_run_id UUID NOT NULL REFERENCES "__SCHEMA__".suite_runs (id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL,
  ordinal INT NOT NULL,
  group_id TEXT,
  display_name TEXT NOT NULL,
  scenario_id UUID NOT NULL REFERENCES "__SCHEMA__".scenarios (id) ON DELETE RESTRICT,
  scenario_version_id UUID NOT NULL REFERENCES "__SCHEMA__".scenario_versions (id) ON DELETE RESTRICT,
  child_run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs (id) ON DELETE RESTRICT,
  admission_status TEXT NOT NULL,
  skip_reason TEXT,
  target_account_id UUID REFERENCES "__SCHEMA__".target_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT suite_run_items_admission_check CHECK (admission_status IN ('PENDING', 'ACTIVE', 'SETTLED', 'SKIPPED'))
);
CREATE UNIQUE INDEX suite_run_items_member_idx ON "__SCHEMA__".suite_run_items (suite_run_id, member_id);
CREATE UNIQUE INDEX suite_run_items_ordinal_idx ON "__SCHEMA__".suite_run_items (suite_run_id, ordinal);
CREATE UNIQUE INDEX suite_run_items_child_idx ON "__SCHEMA__".suite_run_items (child_run_id);
CREATE UNIQUE INDEX suite_run_items_one_active_idx ON "__SCHEMA__".suite_run_items (suite_run_id) WHERE admission_status = 'ACTIVE';

CREATE TABLE "__SCHEMA__".suite_run_events (
  suite_run_id UUID NOT NULL REFERENCES "__SCHEMA__".suite_runs (id) ON DELETE RESTRICT,
  seq INT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (suite_run_id, seq)
);

CREATE TABLE "__SCHEMA__".run_report_contexts (
  run_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".runs (id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  report_config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "__SCHEMA__".report_profiles (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  revision INT NOT NULL,
  config JSONB NOT NULL,
  updated_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT report_profiles_revision_check CHECK (revision > 0)
);
CREATE UNIQUE INDEX report_profiles_target_name_idx ON "__SCHEMA__".report_profiles (target_id, name);

CREATE TABLE "__SCHEMA__".artifacts (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INT,
  digest TEXT,
  retain_until TIMESTAMPTZ NOT NULL,
  created_by_console_account_id UUID REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT artifacts_kind_check CHECK (kind IN ('brand_logo', 'report_material', 'report_docx', 'report_pdf', 'report_bundle'))
);
CREATE INDEX artifacts_target_idx ON "__SCHEMA__".artifacts (target_id, created_at);

ALTER TABLE "__SCHEMA__".stored_objects ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE "__SCHEMA__".stored_objects ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'run';
ALTER TABLE "__SCHEMA__".stored_objects ADD COLUMN artifact_id UUID REFERENCES "__SCHEMA__".artifacts (id) ON DELETE RESTRICT;
ALTER TABLE "__SCHEMA__".stored_objects
  ADD CONSTRAINT stored_objects_owner_check CHECK (
    (owner_kind = 'run' AND run_id IS NOT NULL AND artifact_id IS NULL)
    OR (owner_kind = 'artifact' AND artifact_id IS NOT NULL AND run_id IS NULL)
  );
CREATE INDEX stored_objects_artifact_id_idx ON "__SCHEMA__".stored_objects (artifact_id);
CREATE INDEX stored_objects_owner_kind_idx ON "__SCHEMA__".stored_objects (owner_kind, retain_until);

CREATE TABLE "__SCHEMA__".reports (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL,
  run_id UUID REFERENCES "__SCHEMA__".runs (id) ON DELETE RESTRICT,
  suite_run_id UUID REFERENCES "__SCHEMA__".suite_runs (id) ON DELETE RESTRICT,
  created_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reports_subject_check CHECK (
    (subject_kind = 'RUN' AND run_id IS NOT NULL AND suite_run_id IS NULL)
    OR (subject_kind = 'SUITE_RUN' AND suite_run_id IS NOT NULL AND run_id IS NULL)
  )
);
CREATE INDEX reports_run_idx ON "__SCHEMA__".reports (run_id, created_at);
CREATE INDEX reports_suite_run_idx ON "__SCHEMA__".reports (suite_run_id, created_at);
CREATE INDEX reports_target_idx ON "__SCHEMA__".reports (target_id, created_at);

CREATE TABLE "__SCHEMA__".report_source_snapshots (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES "__SCHEMA__".reports (id) ON DELETE RESTRICT,
  payload JSONB NOT NULL,
  digest TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE "__SCHEMA__".report_revisions (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES "__SCHEMA__".reports (id) ON DELETE RESTRICT,
  revision_no INT NOT NULL,
  stage TEXT NOT NULL,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  config JSONB NOT NULL,
  template_version TEXT NOT NULL,
  render_version TEXT NOT NULL,
  source_snapshot_id UUID NOT NULL REFERENCES "__SCHEMA__".report_source_snapshots (id) ON DELETE RESTRICT,
  parent_report_revision_id UUID REFERENCES "__SCHEMA__".report_revisions (id) ON DELETE RESTRICT,
  content_completeness TEXT NOT NULL DEFAULT 'complete',
  document JSONB,
  sealed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT report_revisions_stage_check CHECK (stage IN ('final', 'phase')),
  CONSTRAINT report_revisions_scope_check CHECK (scope IN ('run', 'suite_summary', 'suite_bundle'))
);
CREATE UNIQUE INDEX report_revisions_no_idx ON "__SCHEMA__".report_revisions (report_id, revision_no);

CREATE TABLE "__SCHEMA__".report_revision_materials (
  id UUID PRIMARY KEY,
  revision_id UUID NOT NULL REFERENCES "__SCHEMA__".report_revisions (id) ON DELETE RESTRICT,
  evidence_id UUID REFERENCES "__SCHEMA__".evidences (id) ON DELETE RESTRICT,
  artifact_id UUID REFERENCES "__SCHEMA__".artifacts (id) ON DELETE RESTRICT,
  missing_reason TEXT,
  digest TEXT
);
CREATE INDEX report_revision_materials_evidence_idx ON "__SCHEMA__".report_revision_materials (evidence_id);

CREATE TABLE "__SCHEMA__".export_jobs (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  report_id UUID REFERENCES "__SCHEMA__".reports (id) ON DELETE RESTRICT,
  report_revision_id UUID REFERENCES "__SCHEMA__".report_revisions (id) ON DELETE RESTRICT,
  created_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  content_completeness TEXT,
  source_manifest JSONB NOT NULL,
  request_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  progress TEXT,
  error TEXT,
  holder_worker_id TEXT,
  holder_instance_id UUID,
  claim_epoch INT NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  retry_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT export_jobs_kind_check CHECK (kind IN ('report_materialize', 'report_render', 'report_bundle')),
  CONSTRAINT export_jobs_status_check CHECK (status IN ('queued', 'running', 'complete', 'partial', 'failed', 'cancelled'))
);
CREATE UNIQUE INDEX export_jobs_idempotency_idx ON "__SCHEMA__".export_jobs (created_by_console_account_id, idempotency_key);
CREATE UNIQUE INDEX export_jobs_revision_format_idx ON "__SCHEMA__".export_jobs (report_revision_id, kind, request_digest);
CREATE INDEX export_jobs_claim_idx ON "__SCHEMA__".export_jobs (status, lease_until);

CREATE TABLE "__SCHEMA__".export_job_events (
  job_id UUID NOT NULL REFERENCES "__SCHEMA__".export_jobs (id) ON DELETE RESTRICT,
  seq INT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE "__SCHEMA__".export_job_artifacts (
  job_id UUID NOT NULL REFERENCES "__SCHEMA__".export_jobs (id) ON DELETE RESTRICT,
  artifact_id UUID NOT NULL REFERENCES "__SCHEMA__".artifacts (id) ON DELETE RESTRICT,
  PRIMARY KEY (job_id, artifact_id)
);

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
JOIN (VALUES
  ('admin', 'suite:read'),
  ('admin', 'suite:write'),
  ('admin', 'suite:delete'),
  ('admin', 'report:read'),
  ('admin', 'report:export'),
  ('admin', 'report:delete'),
  ('author', 'suite:read'),
  ('author', 'suite:write'),
  ('author', 'suite:delete'),
  ('author', 'report:read'),
  ('author', 'report:export'),
  ('operator', 'suite:read'),
  ('operator', 'report:read'),
  ('operator', 'report:export'),
  ('viewer', 'suite:read'),
  ('viewer', 'report:read')
) AS p(role_key, permission) ON p.role_key = r.key
WHERE r.kind = 'system'
ON CONFLICT DO NOTHING;
