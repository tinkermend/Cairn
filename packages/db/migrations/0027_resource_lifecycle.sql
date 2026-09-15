-- 0027: Resource lifecycle soft-deletion, audit actor snapshot, and ledger-based object cleanup.

ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by JSONB,
  ADD CONSTRAINT targets_deleted_shape
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

CREATE INDEX IF NOT EXISTS targets_deleted_created_idx
  ON "__SCHEMA__".targets (deleted_at, created_at);

ALTER TABLE "__SCHEMA__".target_accounts
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by JSONB,
  ADD CONSTRAINT target_accounts_deleted_shape
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

CREATE INDEX IF NOT EXISTS target_accounts_target_deleted_created_idx
  ON "__SCHEMA__".target_accounts (target_id, deleted_at, created_at);

ALTER TABLE "__SCHEMA__".scenarios
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by JSONB,
  ADD CONSTRAINT scenarios_deleted_shape
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

CREATE INDEX IF NOT EXISTS scenarios_target_deleted_created_idx
  ON "__SCHEMA__".scenarios (target_id, deleted_at, created_at);

ALTER TABLE "__SCHEMA__".runs
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by JSONB,
  ADD CONSTRAINT runs_deleted_shape
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

CREATE INDEX IF NOT EXISTS runs_target_deleted_created_idx
  ON "__SCHEMA__".runs (target_id, deleted_at, created_at);

CREATE INDEX IF NOT EXISTS runs_scenario_deleted_created_idx
  ON "__SCHEMA__".runs (scenario_id, deleted_at, created_at);

ALTER TABLE "__SCHEMA__".recording_drafts
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by JSONB,
  ADD CONSTRAINT recording_drafts_deleted_shape
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

CREATE INDEX IF NOT EXISTS recording_drafts_target_deleted_created_idx
  ON "__SCHEMA__".recording_drafts (target_id, deleted_at, created_at);

ALTER TABLE "__SCHEMA__".stored_objects
  ADD COLUMN delete_requested_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS stored_objects_delete_requested_idx
  ON "__SCHEMA__".stored_objects (delete_requested_at, purged_at);

ALTER TABLE "__SCHEMA__".stored_objects
  DROP CONSTRAINT IF EXISTS stored_objects_purge_reason_check;

ALTER TABLE "__SCHEMA__".stored_objects
  ADD CONSTRAINT stored_objects_purge_reason_check
  CHECK (purge_reason IS NULL OR purge_reason IN ('expired', 'upload_incomplete', 'run_deleted'));

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT id, 'run:delete' FROM "__SCHEMA__".console_roles WHERE key = 'admin'
ON CONFLICT DO NOTHING;
