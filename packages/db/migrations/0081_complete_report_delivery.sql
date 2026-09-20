-- 0081：版本化报告默认配置、冻结材料、唯一文件缓存与一次性自动报告。
ALTER TABLE "__SCHEMA__".report_profiles ADD COLUMN edit_scope TEXT NOT NULL DEFAULT 'scenario';
ALTER TABLE "__SCHEMA__".report_profiles ADD CONSTRAINT report_profiles_scope_check CHECK (edit_scope IN ('scenario', 'suite'));
CREATE TABLE "__SCHEMA__".report_profile_versions (
  id UUID PRIMARY KEY, profile_id UUID NOT NULL REFERENCES "__SCHEMA__".report_profiles(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0), name TEXT NOT NULL, config JSONB NOT NULL,
  created_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX report_profile_versions_revision_idx ON "__SCHEMA__".report_profile_versions(profile_id, revision);
INSERT INTO "__SCHEMA__".report_profile_versions(id, profile_id, revision, name, config, created_by_console_account_id, created_at)
  SELECT id, id, revision, name, config, updated_by_console_account_id, updated_at FROM "__SCHEMA__".report_profiles;
CREATE TABLE "__SCHEMA__".scenario_report_defaults (
  scenario_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".scenarios(id) ON DELETE RESTRICT,
  profile_id UUID REFERENCES "__SCHEMA__".report_profiles(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0)
);
ALTER TABLE "__SCHEMA__".run_report_contexts ADD COLUMN target_name TEXT, ADD COLUMN config_sources JSONB;
ALTER TABLE "__SCHEMA__".report_revisions ADD COLUMN preparation_error TEXT, ADD COLUMN document_digest TEXT;
ALTER TABLE "__SCHEMA__".export_jobs ADD COLUMN deadline_at TIMESTAMPTZ;
ALTER TABLE "__SCHEMA__".artifacts
  ADD COLUMN export_job_id UUID REFERENCES "__SCHEMA__".export_jobs(id) ON DELETE RESTRICT,
  ADD COLUMN report_revision_id UUID REFERENCES "__SCHEMA__".report_revisions(id) ON DELETE RESTRICT;
CREATE INDEX artifacts_export_job_idx ON "__SCHEMA__".artifacts(export_job_id);
CREATE INDEX artifacts_revision_idx ON "__SCHEMA__".artifacts(report_revision_id);
ALTER TABLE "__SCHEMA__".report_revision_materials
  ADD COLUMN source_digest TEXT,
  ADD COLUMN source_object_id UUID REFERENCES "__SCHEMA__".stored_objects(id) ON DELETE RESTRICT,
  ADD COLUMN source_artifact_id UUID REFERENCES "__SCHEMA__".artifacts(id) ON DELETE RESTRICT,
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'index',
  ADD COLUMN status TEXT NOT NULL DEFAULT 'missing',
  ADD COLUMN run_id UUID REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  ADD COLUMN caption TEXT NOT NULL DEFAULT '', ADD COLUMN byte_size INTEGER,
  ADD COLUMN width INTEGER, ADD COLUMN height INTEGER,
  ADD CONSTRAINT report_material_kind_check CHECK (kind IN ('index', 'screenshot', 'logo')),
  ADD CONSTRAINT report_material_status_check CHECK (status IN ('pending', 'ready', 'missing')),
  ADD CONSTRAINT report_material_ready_check CHECK (status <> 'ready' OR (artifact_id IS NOT NULL AND digest IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0));
CREATE INDEX report_material_revision_idx ON "__SCHEMA__".report_revision_materials(revision_id);
CREATE TABLE "__SCHEMA__".report_revision_outputs (
  id UUID PRIMARY KEY,
  revision_id UUID NOT NULL REFERENCES "__SCHEMA__".report_revisions(id) ON DELETE RESTRICT,
  format VARCHAR(8) NOT NULL CHECK (format IN ('docx', 'pdf')), render_version VARCHAR(64) NOT NULL,
  artifact_id UUID NOT NULL REFERENCES "__SCHEMA__".artifacts(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX report_revision_outputs_format_idx ON "__SCHEMA__".report_revision_outputs(revision_id, format, render_version);
CREATE TABLE "__SCHEMA__".suite_report_triggers (
  suite_run_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".suite_runs(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'created', 'skipped', 'failed')),
  report_id UUID REFERENCES "__SCHEMA__".reports(id) ON DELETE RESTRICT, reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX suite_report_triggers_pending_idx ON "__SCHEMA__".suite_report_triggers(status, updated_at);
