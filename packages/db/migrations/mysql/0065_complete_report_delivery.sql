-- 0081 的 MySQL 等价增量：版本化默认配置、材料封存与自动报告。
ALTER TABLE report_profiles ADD COLUMN edit_scope VARCHAR(16) NOT NULL DEFAULT 'scenario', ADD CONSTRAINT report_profiles_scope_check CHECK (edit_scope IN ('scenario', 'suite'));
CREATE TABLE report_profile_versions (
  id VARCHAR(36) PRIMARY KEY, profile_id VARCHAR(36) NOT NULL, revision INT NOT NULL CHECK (revision > 0), name TEXT NOT NULL, config JSON NOT NULL,
  created_by_console_account_id VARCHAR(36) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (profile_id) REFERENCES report_profiles(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX report_profile_versions_revision_idx ON report_profile_versions(profile_id, revision);
INSERT INTO report_profile_versions(id, profile_id, revision, name, config, created_by_console_account_id, created_at)
  SELECT id, id, revision, name, config, updated_by_console_account_id, updated_at FROM report_profiles;
CREATE TABLE scenario_report_defaults (
  scenario_id VARCHAR(36) PRIMARY KEY, profile_id VARCHAR(36), revision INT NOT NULL CHECK (revision > 0),
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id) REFERENCES report_profiles(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
ALTER TABLE run_report_contexts ADD COLUMN target_name TEXT, ADD COLUMN config_sources JSON;
ALTER TABLE report_revisions ADD COLUMN preparation_error TEXT, ADD COLUMN document_digest TEXT;
ALTER TABLE export_jobs ADD COLUMN deadline_at DATETIME(3);
ALTER TABLE artifacts ADD COLUMN export_job_id VARCHAR(36), ADD COLUMN report_revision_id VARCHAR(36),
  ADD FOREIGN KEY (export_job_id) REFERENCES export_jobs(id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (report_revision_id) REFERENCES report_revisions(id) ON DELETE RESTRICT;
CREATE INDEX artifacts_export_job_idx ON artifacts(export_job_id);
CREATE INDEX artifacts_revision_idx ON artifacts(report_revision_id);
ALTER TABLE report_revision_materials
  ADD COLUMN source_digest TEXT, ADD COLUMN source_object_id VARCHAR(36), ADD COLUMN source_artifact_id VARCHAR(36),
  ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'index', ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'missing',
  ADD COLUMN run_id VARCHAR(36), ADD COLUMN caption TEXT NOT NULL DEFAULT (''), ADD COLUMN byte_size INT, ADD COLUMN width INT, ADD COLUMN height INT,
  ADD FOREIGN KEY (source_object_id) REFERENCES stored_objects(id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (source_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT report_material_kind_check CHECK (kind IN ('index', 'screenshot', 'logo')),
  ADD CONSTRAINT report_material_status_check CHECK (status IN ('pending', 'ready', 'missing')),
  ADD CONSTRAINT report_material_ready_check CHECK (status <> 'ready' OR (artifact_id IS NOT NULL AND digest IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0));
CREATE INDEX report_material_revision_idx ON report_revision_materials(revision_id);
CREATE TABLE report_revision_outputs (
  id VARCHAR(36) PRIMARY KEY, revision_id VARCHAR(36) NOT NULL, format VARCHAR(8) NOT NULL CHECK (format IN ('docx', 'pdf')),
  render_version VARCHAR(64) NOT NULL, artifact_id VARCHAR(36) NOT NULL,
  FOREIGN KEY (revision_id) REFERENCES report_revisions(id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX report_revision_outputs_format_idx ON report_revision_outputs(revision_id, format, render_version);
CREATE TABLE suite_report_triggers (
  suite_run_id VARCHAR(36) PRIMARY KEY, status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'created', 'skipped', 'failed')),
  report_id VARCHAR(36), reason TEXT, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (suite_run_id) REFERENCES suite_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX suite_report_triggers_pending_idx ON suite_report_triggers(status, updated_at);
