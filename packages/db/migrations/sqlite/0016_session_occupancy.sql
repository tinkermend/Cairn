-- 0032 的 SQLite 等价增量：重建 session_leases 以改 run_id 可空并加 XOR / 用途约束。

PRAGMA foreign_keys=OFF;

CREATE TABLE "session_leases_new" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "session_generation" INTEGER NOT NULL CHECK ("session_generation" IS NULL OR (typeof("session_generation") = 'integer' AND "session_generation" BETWEEN -2147483648 AND 2147483647)),
  "session_fencing_token" INTEGER NOT NULL CHECK ("session_fencing_token" IS NULL OR (typeof("session_fencing_token") = 'integer' AND "session_fencing_token" BETWEEN -2147483648 AND 2147483647)),
  "run_id" TEXT,
  "run_fencing_token" INTEGER CHECK ("run_fencing_token" IS NULL OR (typeof("run_fencing_token") = 'integer' AND "run_fencing_token" BETWEEN -2147483648 AND 2147483647)),
  "holder_worker_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "acquired_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "heartbeat_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "expires_at" TEXT NOT NULL,
  "released_at" TEXT,
  "release_reason" TEXT,
  "purpose" TEXT NOT NULL DEFAULT 'EXECUTION',
  "owner_kind" TEXT NOT NULL DEFAULT 'RUN',
  "operation_id" TEXT,
  "wait_deadline_at" TEXT,
  CONSTRAINT "session_leases_fencing_check" CHECK (((session_generation >= 1) AND (session_fencing_token >= 1) AND ((run_fencing_token IS NULL) OR (run_fencing_token >= 1)))),
  CONSTRAINT "session_leases_pkey" PRIMARY KEY (id),
  CONSTRAINT "session_leases_released_check" CHECK (((status = 'ACTIVE') = (released_at IS NULL))),
  CONSTRAINT "session_leases_run_fencing_purpose_check" CHECK (((status <> 'ACTIVE') OR (purpose <> 'EXECUTION') OR (run_fencing_token IS NOT NULL))),
  CONSTRAINT "session_leases_purpose_check" CHECK ((purpose IN ('EXECUTION', 'MAINTENANCE', 'AUTH_WAIT'))),
  CONSTRAINT "session_leases_owner_kind_check" CHECK ((owner_kind IN ('RUN', 'SESSION_OPERATION'))),
  CONSTRAINT "session_leases_owner_xor_check" CHECK (
    (owner_kind = 'RUN' AND run_id IS NOT NULL AND operation_id IS NULL)
    OR (owner_kind = 'SESSION_OPERATION' AND operation_id IS NOT NULL AND run_id IS NULL)
  ),
  CONSTRAINT "session_leases_purpose_owner_check" CHECK (
    (purpose = 'EXECUTION' AND owner_kind = 'RUN')
    OR (purpose = 'MAINTENANCE' AND owner_kind = 'SESSION_OPERATION')
    OR purpose = 'AUTH_WAIT'
  ),
  CONSTRAINT "session_leases_wait_deadline_check" CHECK ((purpose = 'AUTH_WAIT') = (wait_deadline_at IS NOT NULL)),
  CONSTRAINT "session_leases_run_id_fkey" FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  CONSTRAINT "session_leases_session_id_fkey" FOREIGN KEY (session_id) REFERENCES browser_sessions(id) ON DELETE RESTRICT,
  CONSTRAINT "session_leases_status_check" CHECK ((status IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED')))
);

INSERT INTO "session_leases_new" (
  "id", "session_id", "session_generation", "session_fencing_token", "run_id", "run_fencing_token",
  "holder_worker_id", "status", "acquired_at", "heartbeat_at", "expires_at", "released_at",
  "release_reason", "purpose", "owner_kind", "operation_id", "wait_deadline_at"
)
SELECT
  "id", "session_id", "session_generation", "session_fencing_token", "run_id", "run_fencing_token",
  "holder_worker_id", "status", "acquired_at", "heartbeat_at", "expires_at", "released_at",
  "release_reason", 'EXECUTION', 'RUN', NULL, NULL
FROM "session_leases";

DROP TABLE "session_leases";
ALTER TABLE "session_leases_new" RENAME TO "session_leases";

CREATE UNIQUE INDEX session_leases_active_idx ON session_leases (session_id) WHERE (status = 'ACTIVE');
CREATE INDEX session_leases_holder_idx ON session_leases (holder_worker_id, status);
CREATE INDEX session_leases_reap_idx ON session_leases (status, expires_at) WHERE (status = 'ACTIVE');
CREATE INDEX session_leases_run_id_idx ON session_leases (run_id);
CREATE INDEX session_leases_operation_id_idx ON session_leases (operation_id);
CREATE INDEX session_leases_wait_deadline_idx ON session_leases (status, wait_deadline_at) WHERE (status = 'ACTIVE');

CREATE TABLE session_operations (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  kind_params TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(kind_params)),
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  expected_session_id TEXT,
  expected_generation INTEGER,
  idempotency_key TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  auth_rule_revision INTEGER,
  account_config_digest TEXT,
  secret_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(secret_refs)),
  resource_policy TEXT CHECK (resource_policy IS NULL OR json_valid(resource_policy)),
  platform_config_revision INTEGER NOT NULL,
  queue_deadline_at TEXT NOT NULL,
  claim_token TEXT,
  owner_worker_id TEXT,
  owner_worker_instance_id TEXT,
  attempt_no INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  CONSTRAINT session_operations_pkey PRIMARY KEY (id),
  CONSTRAINT session_operations_kind_check CHECK (kind IN ('VALIDATE_AUTH_PROFILE')),
  CONSTRAINT session_operations_origin_check CHECK (origin IN ('USER', 'BACKGROUND')),
  CONSTRAINT session_operations_status_check
    CHECK (status IN ('QUEUED', 'RUNNING', 'WAITING_FOR_AUTH', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  CONSTRAINT session_operations_attempt_check CHECK (attempt_no >= 0),
  CONSTRAINT session_operations_terminal_check
    CHECK ((status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) = (finished_at IS NOT NULL)),
  CONSTRAINT session_operations_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT session_operations_target_account_fkey
    FOREIGN KEY (target_account_id, target_id) REFERENCES target_accounts(id, target_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX session_operations_idempotency_idx
  ON session_operations (target_id, target_account_id, idempotency_key);
CREATE INDEX session_operations_claim_idx ON session_operations (status, created_at);
CREATE INDEX session_operations_key_idx ON session_operations (target_id, target_account_id, status);

CREATE TABLE session_profiles (
  target_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  location_worker_id TEXT,
  state TEXT NOT NULL,
  pending_cleanups TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_cleanups)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT session_profiles_pkey PRIMARY KEY (target_id, target_account_id),
  CONSTRAINT session_profiles_revision_check CHECK (revision >= 1),
  CONSTRAINT session_profiles_state_check CHECK (state IN ('ABSENT', 'PRESENT')),
  CONSTRAINT session_profiles_target_account_fkey
    FOREIGN KEY (target_account_id, target_id) REFERENCES target_accounts(id, target_id) ON DELETE RESTRICT
);

ALTER TABLE workers ADD COLUMN protocol_capabilities TEXT NOT NULL DEFAULT '[]';

-- SQLite 不能廉价给已有表追加外键；operation_id 由写路径与 PG/MySQL 约束保证。

PRAGMA foreign_keys=ON;
