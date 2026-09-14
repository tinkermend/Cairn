-- Controlled execution credentials. Keys never contain console permissions.

CREATE TABLE service_callers (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  requests_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (requests_per_minute BETWEEN 1 AND 600),
  max_outstanding_runs INTEGER NOT NULL DEFAULT 2 CHECK (max_outstanding_runs BETWEEN 1 AND 20),
  run_timeout_seconds INTEGER NOT NULL DEFAULT 600 CHECK (run_timeout_seconds BETWEEN 1 AND 3600),
  window_started_at TEXT,
  window_requests INTEGER NOT NULL DEFAULT 0 CHECK (window_requests >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE service_credentials (
  id TEXT NOT NULL PRIMARY KEY,
  caller_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_digest TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  created_by_console_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (caller_id) REFERENCES service_callers(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX service_credentials_caller_id_idx ON service_credentials(caller_id,id);

CREATE UNIQUE INDEX target_accounts_target_id_pair_idx ON target_accounts(target_id,id);

CREATE TABLE credential_target_grants (
  credential_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  allow_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (allow_anonymous IN (0,1)),
  PRIMARY KEY (credential_id,target_id),
  FOREIGN KEY (credential_id) REFERENCES service_credentials(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE credential_target_account_grants (
  credential_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  PRIMARY KEY (credential_id,target_id,target_account_id),
  FOREIGN KEY (credential_id,target_id) REFERENCES credential_target_grants(credential_id,target_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id,target_account_id) REFERENCES target_accounts(target_id,id) ON DELETE RESTRICT
);

CREATE INDEX credential_account_target_idx ON credential_target_account_grants(target_id,target_account_id);

PRAGMA foreign_keys=OFF;

BEGIN IMMEDIATE;

CREATE TABLE "runs_service_new" (
  "id" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "scenario_id" TEXT NOT NULL,
  "scenario_version_id" TEXT NOT NULL,
  "target_account_id" TEXT,
  "created_by_console_account_id" TEXT,
  "status" TEXT NOT NULL,
  "cancel_requested_at" TEXT,
  "started_at" TEXT,
  "finished_at" TEXT,
  "snapshot" TEXT NOT NULL CHECK ("snapshot" IS NULL OR json_valid("snapshot")),
  "snapshot_digest" TEXT NOT NULL,
  "context" TEXT NOT NULL CHECK ("context" IS NULL OR json_valid("context")),
  "idempotency_key" TEXT,
  "idempotency_digest" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "evidence_status" TEXT NOT NULL DEFAULT 'PENDING',
  service_caller_id TEXT,
  service_credential_id TEXT,
  service_admission TEXT CHECK (service_admission IS NULL OR json_valid(service_admission)),
  deadline_at TEXT,
  cancel_reason TEXT,
  CONSTRAINT "runs_created_by_console_account_id_fkey" FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT "runs_evidence_status_check" CHECK ((evidence_status IN ('PENDING', 'COMPLETE', 'INCOMPLETE'))),
  CONSTRAINT "runs_idempotency_pair" CHECK (((idempotency_key IS NULL) = (idempotency_digest IS NULL))),
  CONSTRAINT "runs_pkey" PRIMARY KEY (id),
  CONSTRAINT "runs_scenario_id_fkey" FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE RESTRICT,
  CONSTRAINT "runs_scenario_version_id_fkey" FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT,
  CONSTRAINT "runs_status_check" CHECK ((status IN ('QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH', 'NEEDS_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELLED'))),
  CONSTRAINT "runs_target_account_id_fkey" FOREIGN KEY (target_account_id) REFERENCES target_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT "runs_target_id_fkey" FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT runs_actor_shape CHECK ((created_by_console_account_id IS NOT NULL AND service_caller_id IS NULL AND service_credential_id IS NULL AND service_admission IS NULL AND deadline_at IS NULL) OR (created_by_console_account_id IS NULL AND service_caller_id IS NOT NULL AND service_credential_id IS NOT NULL AND service_admission IS NOT NULL AND deadline_at IS NOT NULL AND idempotency_key IS NOT NULL)),
  FOREIGN KEY (service_caller_id,service_credential_id) REFERENCES service_credentials(caller_id,id) ON DELETE RESTRICT
);

INSERT INTO runs_service_new (id,target_id,scenario_id,scenario_version_id,target_account_id,created_by_console_account_id,status,cancel_requested_at,started_at,finished_at,snapshot,snapshot_digest,context,idempotency_key,idempotency_digest,created_at,updated_at,evidence_status) SELECT id,target_id,scenario_id,scenario_version_id,target_account_id,created_by_console_account_id,status,cancel_requested_at,started_at,finished_at,snapshot,snapshot_digest,context,idempotency_key,idempotency_digest,created_at,updated_at,evidence_status FROM runs;

DROP TABLE runs;

ALTER TABLE runs_service_new RENAME TO runs;

CREATE UNIQUE INDEX runs_idempotency_idx ON runs(created_by_console_account_id,idempotency_key);

CREATE INDEX runs_claim_idx ON runs(status,created_at,id);

CREATE UNIQUE INDEX runs_idempotency_service_idx ON runs(service_caller_id,idempotency_key);

CREATE INDEX runs_service_status_idx ON runs(service_caller_id,status);

CREATE INDEX runs_deadline_idx ON runs(deadline_at,status);

CREATE TRIGGER runs_snapshot_immutable BEFORE UPDATE ON runs WHEN OLD.snapshot IS NOT NEW.snapshot OR OLD.snapshot_digest IS NOT NEW.snapshot_digest OR OLD.target_id IS NOT NEW.target_id OR OLD.target_account_id IS NOT NEW.target_account_id OR OLD.scenario_id IS NOT NEW.scenario_id OR OLD.scenario_version_id IS NOT NEW.scenario_version_id OR OLD.created_by_console_account_id IS NOT NEW.created_by_console_account_id OR OLD.service_caller_id IS NOT NEW.service_caller_id OR OLD.service_credential_id IS NOT NEW.service_credential_id OR OLD.service_admission IS NOT NEW.service_admission OR OLD.deadline_at IS NOT NEW.deadline_at OR OLD.idempotency_key IS NOT NEW.idempotency_key OR OLD.idempotency_digest IS NOT NEW.idempotency_digest BEGIN SELECT RAISE(ABORT, 'runs immutable'); END;

COMMIT;

PRAGMA foreign_keys=ON;

ALTER TABLE evidences ADD COLUMN external_access INTEGER NOT NULL DEFAULT 0 CHECK (external_access IN (0,1));

ALTER TABLE console_audit_events ADD COLUMN actor_service_caller_id TEXT REFERENCES service_callers(id);

ALTER TABLE console_audit_events ADD COLUMN actor_service_credential_id TEXT REFERENCES service_credentials(id) ON DELETE RESTRICT CHECK ((actor_service_caller_id IS NULL AND actor_service_credential_id IS NULL) OR (actor_console_account_id IS NULL AND actor_service_caller_id IS NOT NULL AND actor_service_credential_id IS NOT NULL AND category = 'operation'));

CREATE TRIGGER audit_service_pair_insert BEFORE INSERT ON console_audit_events WHEN NEW.actor_service_caller_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_credentials WHERE caller_id = NEW.actor_service_caller_id AND id = NEW.actor_service_credential_id) BEGIN SELECT RAISE(ABORT, 'audit service actor mismatch'); END;

CREATE TRIGGER audit_service_pair_update BEFORE UPDATE ON console_audit_events WHEN NEW.actor_service_caller_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_credentials WHERE caller_id = NEW.actor_service_caller_id AND id = NEW.actor_service_credential_id) BEGIN SELECT RAISE(ABORT, 'audit service actor mismatch'); END;

INSERT INTO console_role_permissions(console_role_id,permission) SELECT id, 'service:read' FROM console_roles WHERE key = 'admin';

INSERT INTO console_role_permissions(console_role_id,permission) SELECT id, 'service:write' FROM console_roles WHERE key = 'admin';

ALTER TABLE console_audit_events ADD COLUMN request_id TEXT;
