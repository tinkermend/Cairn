-- 0016_audit_login：控制台审计拆成操作 / 登录，补登录字段与 admin 权限
--
-- 存量变更行靠 category 默认值归入 operation，不改写历史。
-- 全文幂等：重复执行不产生副作用。

ALTER TABLE "__SCHEMA__".console_audit_events
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'operation',
  ADD COLUMN IF NOT EXISTS client_ip TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  ADD COLUMN IF NOT EXISTS client_kind TEXT,
  ADD COLUMN IF NOT EXISTS login_identifier TEXT,
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'console_audit_events_category_check'
      AND conrelid = '"__SCHEMA__".console_audit_events'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".console_audit_events
      ADD CONSTRAINT console_audit_events_category_check
      CHECK (category IN ('operation', 'login'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'console_audit_events_client_kind_check'
      AND conrelid = '"__SCHEMA__".console_audit_events'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".console_audit_events
      ADD CONSTRAINT console_audit_events_client_kind_check
      CHECK (client_kind IS NULL OR client_kind IN ('web', 'extension'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'console_audit_events_shape_check'
      AND conrelid = '"__SCHEMA__".console_audit_events'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".console_audit_events
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
              AND actor_console_account_id IS NOT NULL
              AND resource_id IS NOT NULL
            )
            OR (
              outcome = 'failure'
              AND failure_reason IN ('unknown_account', 'invalid_password', 'account_disabled')
              AND (
                (
                  failure_reason = 'unknown_account'
                  AND actor_console_account_id IS NULL
                  AND resource_id IS NULL
                )
                OR (
                  failure_reason IN ('invalid_password', 'account_disabled')
                  AND actor_console_account_id IS NOT NULL
                  AND resource_id IS NOT NULL
                )
              )
            )
          )
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS console_audit_events_category_created_idx
  ON "__SCHEMA__".console_audit_events (category, created_at DESC);

CREATE INDEX IF NOT EXISTS console_audit_events_login_outcome_idx
  ON "__SCHEMA__".console_audit_events (category, outcome, created_at DESC);

CREATE INDEX IF NOT EXISTS console_audit_events_login_identifier_idx
  ON "__SCHEMA__".console_audit_events (login_identifier);

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, 'audit:login'
FROM "__SCHEMA__".console_roles r
WHERE r.key = 'admin'
ON CONFLICT DO NOTHING;
