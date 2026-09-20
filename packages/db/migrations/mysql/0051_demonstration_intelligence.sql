-- 示教智能，逻辑版本 0067。
ALTER TABLE recording_drafts ADD COLUMN source_protocol text NOT NULL DEFAULT ('recording@1');
ALTER TABLE recording_import_receipts ADD COLUMN demonstration json;
CREATE TABLE recording_demonstration_sources (
 recording_draft_id varchar(36) PRIMARY KEY, source json NOT NULL, fact_digest text NOT NULL,
 received_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY (recording_draft_id) REFERENCES recording_drafts(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE TABLE recording_artifacts (
 id varchar(36) PRIMARY KEY, recording_draft_id varchar(36) NOT NULL, client_asset_id varchar(128) NOT NULL, manifest json NOT NULL,
 status varchar(16) NOT NULL CHECK (status IN ('pending','available','missing','deleting','purged')),
 generation_id varchar(36), expires_at timestamp(3) NOT NULL,
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY (recording_draft_id) REFERENCES recording_drafts(id) ON DELETE RESTRICT,
 UNIQUE KEY recording_artifacts_source_asset_idx (recording_draft_id, client_asset_id), KEY recording_artifacts_expiry_idx (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE TABLE recording_artifact_uploads (
 id varchar(36) PRIMARY KEY, artifact_id varchar(36) NOT NULL, object_key varchar(512) NOT NULL,
 status varchar(16) NOT NULL CHECK (status IN ('pending','committed','deleting','purged')),
 deadline_at timestamp(3) NOT NULL, next_sweep_at timestamp(3) NOT NULL, sweep_count int NOT NULL DEFAULT 0,
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY (artifact_id) REFERENCES recording_artifacts(id) ON DELETE RESTRICT,
 UNIQUE KEY recording_artifact_uploads_key_idx (object_key), KEY recording_artifact_uploads_sweep_idx (status, next_sweep_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE TABLE scenario_validation_subjects (
 scenario_version_id varchar(36) PRIMARY KEY, protocol_version text NOT NULL, subject_digest varchar(64) NOT NULL,
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT,
 KEY scenario_validation_subjects_digest_idx (subject_digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE TABLE run_validation_contexts (
 run_id varchar(36) PRIMARY KEY, subject_digest varchar(64) NOT NULL, execution_scope_digest text NOT NULL, input_digest text NOT NULL,
 provenance text NOT NULL, interventions json NOT NULL, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 CHECK (provenance IN ('full_trial','intervened')), FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
 KEY run_validation_contexts_subject_idx (subject_digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
