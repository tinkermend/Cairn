ALTER TABLE targets ADD COLUMN deleted_at TEXT;
ALTER TABLE targets ADD COLUMN deleted_by TEXT;
CREATE INDEX targets_deleted_created_idx ON targets (deleted_at, created_at);
CREATE TRIGGER targets_deleted_check_ins BEFORE INSERT ON targets WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'targets deleted mismatch'); END;
CREATE TRIGGER targets_deleted_check_upd BEFORE UPDATE ON targets WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'targets deleted mismatch'); END;

ALTER TABLE target_accounts ADD COLUMN deleted_at TEXT;
ALTER TABLE target_accounts ADD COLUMN deleted_by TEXT;
CREATE INDEX target_accounts_target_deleted_created_idx ON target_accounts (target_id, deleted_at, created_at);
CREATE TRIGGER target_accounts_deleted_check_ins BEFORE INSERT ON target_accounts WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'target_accounts deleted mismatch'); END;
CREATE TRIGGER target_accounts_deleted_check_upd BEFORE UPDATE ON target_accounts WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'target_accounts deleted mismatch'); END;

ALTER TABLE scenarios ADD COLUMN deleted_at TEXT;
ALTER TABLE scenarios ADD COLUMN deleted_by TEXT;
CREATE INDEX scenarios_target_deleted_created_idx ON scenarios (target_id, deleted_at, created_at);
CREATE TRIGGER scenarios_deleted_check_ins BEFORE INSERT ON scenarios WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'scenarios deleted mismatch'); END;
CREATE TRIGGER scenarios_deleted_check_upd BEFORE UPDATE ON scenarios WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'scenarios deleted mismatch'); END;

ALTER TABLE runs ADD COLUMN deleted_at TEXT;
ALTER TABLE runs ADD COLUMN deleted_by TEXT;
CREATE INDEX runs_target_deleted_created_idx ON runs (target_id, deleted_at, created_at);
CREATE INDEX runs_scenario_deleted_created_idx ON runs (scenario_id, deleted_at, created_at);
CREATE TRIGGER runs_deleted_check_ins BEFORE INSERT ON runs WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'runs deleted mismatch'); END;
CREATE TRIGGER runs_deleted_check_upd BEFORE UPDATE ON runs WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'runs deleted mismatch'); END;

ALTER TABLE recording_drafts ADD COLUMN deleted_at TEXT;
ALTER TABLE recording_drafts ADD COLUMN deleted_by TEXT;
CREATE INDEX recording_drafts_target_deleted_created_idx ON recording_drafts (target_id, deleted_at, created_at);
CREATE TRIGGER recording_drafts_deleted_check_ins BEFORE INSERT ON recording_drafts WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'recording_drafts deleted mismatch'); END;
CREATE TRIGGER recording_drafts_deleted_check_upd BEFORE UPDATE ON recording_drafts WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'recording_drafts deleted mismatch'); END;

PRAGMA foreign_keys=OFF;

CREATE TABLE "stored_objects_new" (
  "id" TEXT NOT NULL,
  "object_key" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "content_type" TEXT,
  "byte_size" INTEGER CHECK ("byte_size" IS NULL OR (typeof("byte_size") = 'integer' AND "byte_size" BETWEEN -2147483648 AND 2147483647)),
  "digest" TEXT,
  "retain_until" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "available_at" TEXT,
  "delete_requested_at" TEXT,
  "purged_at" TEXT,
  "purge_reason" TEXT,
  "purge_attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("purge_attempts" IS NULL OR (typeof("purge_attempts") = 'integer' AND "purge_attempts" BETWEEN -2147483648 AND 2147483647)),
  "last_purge_error_at" TEXT,
  CONSTRAINT "stored_objects_byte_size_check" CHECK (((byte_size IS NULL) OR (byte_size >= 0))),
  CONSTRAINT "stored_objects_pkey" PRIMARY KEY (id),
  CONSTRAINT "stored_objects_purge_reason_check" CHECK (((purge_reason IS NULL) OR (purge_reason IN ('expired', 'upload_incomplete', 'run_deleted')))),
  CONSTRAINT "stored_objects_run_id_fkey" FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  CONSTRAINT "stored_objects_status_check" CHECK ((status IN ('pending', 'available', 'purged')))
);

INSERT INTO "stored_objects_new" ("id", "object_key", "run_id", "status", "content_type", "byte_size", "digest", "retain_until", "created_at", "available_at", "delete_requested_at", "purged_at", "purge_reason", "purge_attempts", "last_purge_error_at")
  SELECT "id", "object_key", "run_id", "status", "content_type", "byte_size", "digest", "retain_until", "created_at", "available_at", NULL, "purged_at", "purge_reason", "purge_attempts", "last_purge_error_at"
  FROM "stored_objects";

DROP TABLE "stored_objects";

ALTER TABLE "stored_objects_new" RENAME TO "stored_objects";

CREATE UNIQUE INDEX "stored_objects_object_key_idx" ON "stored_objects" ("object_key");
CREATE INDEX "stored_objects_pending_idx" ON "stored_objects" ("status", "created_at");
CREATE INDEX "stored_objects_purge_idx" ON "stored_objects" ("status", "purge_attempts", "retain_until");
CREATE INDEX "stored_objects_run_id_idx" ON "stored_objects" ("run_id");
CREATE INDEX "stored_objects_delete_requested_idx" ON "stored_objects" ("delete_requested_at", "purged_at");

PRAGMA foreign_keys=ON;

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'run:delete' FROM console_roles WHERE key = 'admin';
