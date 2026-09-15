ALTER TABLE targets
  ADD COLUMN deleted_at DATETIME(3),
  ADD COLUMN deleted_by JSON,
  ADD CONSTRAINT targets_deleted_shape
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

CREATE INDEX targets_deleted_created_idx
  ON targets (deleted_at, created_at);

ALTER TABLE target_accounts
  ADD COLUMN deleted_at DATETIME(3),
  ADD COLUMN deleted_by JSON,
  ADD CONSTRAINT target_accounts_deleted_shape
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

CREATE INDEX target_accounts_target_deleted_created_idx
  ON target_accounts (target_id, deleted_at, created_at);

ALTER TABLE scenarios
  ADD COLUMN deleted_at DATETIME(3),
  ADD COLUMN deleted_by JSON,
  ADD CONSTRAINT scenarios_deleted_shape
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

CREATE INDEX scenarios_target_deleted_created_idx
  ON scenarios (target_id, deleted_at, created_at);

ALTER TABLE runs
  ADD COLUMN deleted_at DATETIME(3),
  ADD COLUMN deleted_by JSON,
  ADD CONSTRAINT runs_deleted_shape
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

CREATE INDEX runs_target_deleted_created_idx
  ON runs (target_id, deleted_at, created_at);

CREATE INDEX runs_scenario_deleted_created_idx
  ON runs (scenario_id, deleted_at, created_at);

ALTER TABLE recording_drafts
  ADD COLUMN deleted_at DATETIME(3),
  ADD COLUMN deleted_by JSON,
  ADD CONSTRAINT recording_drafts_deleted_shape
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

CREATE INDEX recording_drafts_target_deleted_created_idx
  ON recording_drafts (target_id, deleted_at, created_at);

ALTER TABLE stored_objects
  ADD COLUMN delete_requested_at DATETIME(3);

CREATE INDEX stored_objects_delete_requested_idx
  ON stored_objects (delete_requested_at, purged_at);

ALTER TABLE stored_objects
  DROP CHECK stored_objects_purge_reason_check;

ALTER TABLE stored_objects
  ADD CONSTRAINT stored_objects_purge_reason_check
  CHECK (((purge_reason IS NULL) OR (purge_reason IN ('expired', 'upload_incomplete', 'run_deleted'))));

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'run:delete' FROM console_roles WHERE `key` = 'admin';
