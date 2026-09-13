-- 0016 的 MySQL 等价增量：登录审计列、形状约束、admin 权限。

ALTER TABLE console_audit_events
  ADD COLUMN category VARCHAR(16) NOT NULL DEFAULT 'operation',
  ADD COLUMN client_ip TEXT,
  ADD COLUMN user_agent TEXT,
  ADD COLUMN client_kind VARCHAR(16),
  ADD COLUMN login_identifier VARCHAR(64),
  ADD COLUMN outcome VARCHAR(16),
  ADD COLUMN failure_reason VARCHAR(32);

-- MySQL 禁止 CHECK 引用带 referential action 的外键列（actor_console_account_id
-- 有 ON DELETE SET NULL）。演员空/非空由写路径卡住，这里用 resource_id 对齐形状。
ALTER TABLE console_audit_events
  ADD CONSTRAINT console_audit_events_category_check
    CHECK (category IN ('operation', 'login')),
  ADD CONSTRAINT console_audit_events_client_kind_check
    CHECK (client_kind IS NULL OR client_kind IN ('web', 'extension')),
  ADD CONSTRAINT console_audit_events_shape_check
    CHECK (
      (
        category = 'operation'
        AND outcome IS NULL
        AND failure_reason IS NULL
        AND login_identifier IS NULL
        AND action <> 'auth.login'
      )
      OR (
        category = 'login'
        AND action = 'auth.login'
        AND resource = 'auth'
        AND login_identifier IS NOT NULL
        AND (
          (
            outcome = 'success'
            AND failure_reason IS NULL
            AND resource_id IS NOT NULL
          )
          OR (
            outcome = 'failure'
            AND failure_reason IN ('unknown_account', 'invalid_password', 'account_disabled')
            AND (
              (
                failure_reason = 'unknown_account'
                AND resource_id IS NULL
              )
              OR (
                failure_reason IN ('invalid_password', 'account_disabled')
                AND resource_id IS NOT NULL
              )
            )
          )
        )
      )
    );

CREATE INDEX console_audit_events_category_created_idx
  ON console_audit_events (category, created_at DESC);

CREATE INDEX console_audit_events_login_outcome_idx
  ON console_audit_events (category, outcome, created_at DESC);

CREATE INDEX console_audit_events_login_identifier_idx
  ON console_audit_events (login_identifier);

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'audit:login' FROM console_roles WHERE `key` = 'admin';
