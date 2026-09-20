-- 示教来源、独立录制附件及版本/运行验证关联。旧录制与 Snapshot 不回填改写。
ALTER TABLE "__SCHEMA__".recording_drafts ADD COLUMN source_protocol text NOT NULL DEFAULT 'recording@1';
ALTER TABLE "__SCHEMA__".recording_import_receipts ADD COLUMN demonstration jsonb;
CREATE TABLE "__SCHEMA__".recording_demonstration_sources (
 recording_draft_id uuid PRIMARY KEY REFERENCES "__SCHEMA__".recording_drafts(id) ON DELETE RESTRICT,
 source jsonb NOT NULL, fact_digest text NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "__SCHEMA__".recording_artifacts (
 id uuid PRIMARY KEY, recording_draft_id uuid NOT NULL REFERENCES "__SCHEMA__".recording_drafts(id) ON DELETE RESTRICT,
 client_asset_id varchar(128) NOT NULL, manifest jsonb NOT NULL,
 status varchar(16) NOT NULL CHECK (status IN ('pending','available','missing','deleting','purged')),
 generation_id uuid, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX recording_artifacts_source_asset_idx ON "__SCHEMA__".recording_artifacts(recording_draft_id, client_asset_id);
CREATE INDEX recording_artifacts_expiry_idx ON "__SCHEMA__".recording_artifacts(status, expires_at);
CREATE TABLE "__SCHEMA__".recording_artifact_uploads (
 id uuid PRIMARY KEY, artifact_id uuid NOT NULL REFERENCES "__SCHEMA__".recording_artifacts(id) ON DELETE RESTRICT,
 object_key varchar(512) NOT NULL, status varchar(16) NOT NULL CHECK (status IN ('pending','committed','deleting','purged')),
 deadline_at timestamptz NOT NULL, next_sweep_at timestamptz NOT NULL, sweep_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX recording_artifact_uploads_key_idx ON "__SCHEMA__".recording_artifact_uploads(object_key);
CREATE INDEX recording_artifact_uploads_sweep_idx ON "__SCHEMA__".recording_artifact_uploads(status, next_sweep_at);
CREATE TABLE "__SCHEMA__".scenario_validation_subjects (
 scenario_version_id uuid PRIMARY KEY REFERENCES "__SCHEMA__".scenario_versions(id) ON DELETE RESTRICT,
 protocol_version text NOT NULL, subject_digest varchar(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scenario_validation_subjects_digest_idx ON "__SCHEMA__".scenario_validation_subjects(subject_digest);
CREATE TABLE "__SCHEMA__".run_validation_contexts (
 run_id uuid PRIMARY KEY REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
 subject_digest varchar(64) NOT NULL, execution_scope_digest text NOT NULL, input_digest text NOT NULL,
 provenance text NOT NULL CHECK (provenance IN ('full_trial','intervened')), interventions jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_validation_contexts_subject_idx ON "__SCHEMA__".run_validation_contexts(subject_digest);
