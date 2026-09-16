-- 0037 的 SQLite 等价增量：会话维护 kind、保留意图、事件账本、session:manage 对账

ALTER TABLE browser_sessions ADD COLUMN retain_until TEXT;
ALTER TABLE browser_sessions ADD COLUMN next_auth_check_at TEXT;
ALTER TABLE browser_sessions ADD COLUMN predecessor_session_id TEXT;

CREATE INDEX browser_sessions_retain_idx ON browser_sessions (retain_until);
CREATE INDEX browser_sessions_auth_check_idx ON browser_sessions (status, next_auth_check_at);

PRAGMA foreign_keys=OFF;

CREATE TABLE session_operations_c (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  kind_params TEXT NOT NULL DEFAULT '{}',
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  expected_session_id TEXT,
  expected_generation INTEGER,
  idempotency_key TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  auth_rule_revision INTEGER,
  account_config_digest TEXT,
  secret_refs TEXT NOT NULL DEFAULT '[]',
  resource_policy TEXT,
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
  CONSTRAINT session_operations_kind_check CHECK (kind IN (
    'VALIDATE_AUTH_PROFILE',
    'PREPARE',
    'VERIFY_AUTH',
    'LOGIN',
    'RENEW_AUTH',
    'REFRESH_LOGIN_PAGE',
    'CLOSE',
    'RESTART',
    'RESET_PROFILE'
  )),
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

INSERT INTO session_operations_c SELECT * FROM session_operations;
DROP TABLE session_operations;
ALTER TABLE session_operations_c RENAME TO session_operations;

CREATE UNIQUE INDEX session_operations_idempotency_idx
  ON session_operations (target_id, target_account_id, idempotency_key);
CREATE INDEX session_operations_claim_idx ON session_operations (status, created_at);
CREATE INDEX session_operations_key_idx ON session_operations (target_id, target_account_id, status);

PRAGMA foreign_keys=ON;

CREATE TABLE session_retention_intents (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  retain_until TEXT NOT NULL,
  reason TEXT,
  created_by TEXT,
  platform_config_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT session_retention_intents_pkey PRIMARY KEY (id),
  CONSTRAINT session_retention_intents_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT session_retention_intents_target_account_fkey
    FOREIGN KEY (target_account_id, target_id) REFERENCES target_accounts(id, target_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX session_retention_intents_key_idx
  ON session_retention_intents (target_id, target_account_id);

CREATE TABLE session_events (
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  target_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  session_id TEXT,
  generation INTEGER,
  operation_id TEXT,
  run_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT session_events_pkey PRIMARY KEY (id),
  CONSTRAINT session_events_seq_check CHECK (seq >= 1)
);

CREATE UNIQUE INDEX session_events_key_seq_idx
  ON session_events (target_id, target_account_id, seq);
CREATE INDEX session_events_session_idx ON session_events (session_id, seq);

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
JOIN (
  SELECT 'admin' AS role_key, 'session:manage' AS permission
  UNION ALL SELECT 'operator', 'session:manage'
) AS p ON p.role_key = r.key
WHERE r.kind = 'system';
