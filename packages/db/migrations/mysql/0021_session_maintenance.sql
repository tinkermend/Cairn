-- 0037 的 MySQL 等价增量：会话维护 kind、保留意图、事件账本、session:manage 对账

ALTER TABLE browser_sessions
  ADD COLUMN retain_until DATETIME(3) NULL,
  ADD COLUMN next_auth_check_at DATETIME(3) NULL,
  ADD COLUMN predecessor_session_id VARCHAR(36) NULL;

CREATE INDEX browser_sessions_retain_idx ON browser_sessions (retain_until);
CREATE INDEX browser_sessions_auth_check_idx ON browser_sessions (status, next_auth_check_at);

ALTER TABLE session_operations
  DROP CHECK session_operations_kind_check;

ALTER TABLE session_operations
  ADD CONSTRAINT session_operations_kind_check
    CHECK (kind IN (
      'VALIDATE_AUTH_PROFILE',
      'PREPARE',
      'VERIFY_AUTH',
      'LOGIN',
      'RENEW_AUTH',
      'REFRESH_LOGIN_PAGE',
      'CLOSE',
      'RESTART',
      'RESET_PROFILE'
    ));

CREATE TABLE session_retention_intents (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36) NOT NULL,
  retain_until DATETIME(3) NOT NULL,
  reason TEXT,
  created_by VARCHAR(36),
  platform_config_revision INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT session_retention_intents_pkey PRIMARY KEY (id),
  CONSTRAINT session_retention_intents_target_id_fkey
    FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT session_retention_intents_target_account_fkey
    FOREIGN KEY (target_account_id, target_id) REFERENCES target_accounts(id, target_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX session_retention_intents_key_idx
  ON session_retention_intents (target_id, target_account_id);

CREATE TABLE session_events (
  id VARCHAR(36) NOT NULL,
  seq INT NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36) NOT NULL,
  session_id VARCHAR(36),
  generation INT,
  operation_id VARCHAR(36),
  run_id VARCHAR(36),
  type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT session_events_pkey PRIMARY KEY (id),
  CONSTRAINT session_events_seq_check CHECK (seq >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX session_events_key_seq_idx
  ON session_events (target_id, target_account_id, seq);
CREATE INDEX session_events_session_idx ON session_events (session_id, seq);

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
JOIN (
  SELECT 'admin' AS role_key, 'session:manage' AS permission
  UNION ALL SELECT 'operator', 'session:manage'
) AS p ON p.role_key = r.key
WHERE r.kind = 'system';
