-- 0037：会话维护 kind、保留意图、事件账本、session:manage 对账

ALTER TABLE "__SCHEMA__".browser_sessions
  ADD COLUMN IF NOT EXISTS retain_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_auth_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS predecessor_session_id UUID;

CREATE INDEX IF NOT EXISTS browser_sessions_retain_idx
  ON "__SCHEMA__".browser_sessions (retain_until)
  WHERE retain_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS browser_sessions_auth_check_idx
  ON "__SCHEMA__".browser_sessions (next_auth_check_at)
  WHERE status IN ('OPEN', 'CREATING') AND next_auth_check_at IS NOT NULL;

ALTER TABLE "__SCHEMA__".session_operations
  DROP CONSTRAINT IF EXISTS session_operations_kind_check;

ALTER TABLE "__SCHEMA__".session_operations
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

CREATE TABLE IF NOT EXISTS "__SCHEMA__".session_retention_intents (
  id                         UUID        PRIMARY KEY,
  target_id                  UUID        NOT NULL
                                         REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  target_account_id          UUID        NOT NULL,
  retain_until               TIMESTAMPTZ NOT NULL,
  reason                     TEXT,
  created_by                 UUID,
  platform_config_revision   INT         NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT session_retention_intents_target_account_fkey
    FOREIGN KEY (target_account_id, target_id)
    REFERENCES "__SCHEMA__".target_accounts (id, target_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS session_retention_intents_key_idx
  ON "__SCHEMA__".session_retention_intents (target_id, target_account_id);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".session_events (
  id                  UUID        PRIMARY KEY,
  seq                 INT         NOT NULL,
  target_id           UUID        NOT NULL,
  target_account_id   UUID        NOT NULL,
  session_id          UUID,
  generation          INT,
  operation_id        UUID,
  run_id              UUID,
  type                TEXT        NOT NULL,
  payload             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT session_events_seq_check CHECK (seq >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS session_events_key_seq_idx
  ON "__SCHEMA__".session_events (target_id, target_account_id, seq);

CREATE INDEX IF NOT EXISTS session_events_session_idx
  ON "__SCHEMA__".session_events (session_id, seq);

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
JOIN (VALUES
  ('admin', 'session:manage'),
  ('operator', 'session:manage')
) AS p(role_key, permission) ON p.role_key = r.key
WHERE r.kind = 'system'
ON CONFLICT DO NOTHING;
