-- 0024：受管浏览器认证占用绑定与 AuthControl。
-- 存量 hold（无 Run 绑定）不授人工输入权。

ALTER TABLE "__SCHEMA__".browser_sessions
  ADD COLUMN IF NOT EXISTS auth_hold_run_id UUID REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS auth_hold_session_generation INTEGER,
  ADD COLUMN IF NOT EXISTS auth_hold_worker_instance_id UUID,
  ADD COLUMN IF NOT EXISTS auth_control_epoch INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auth_control_actor_id UUID REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS auth_control_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS auth_control_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auth_control_page_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_auth_hold_binding_check'
      AND conrelid = '"__SCHEMA__".browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_auth_hold_binding_check
      CHECK (
        (auth_hold_run_id IS NULL AND auth_hold_session_generation IS NULL AND auth_hold_worker_instance_id IS NULL)
        OR (
          auth_hold_worker_id IS NOT NULL
          AND auth_hold_run_id IS NOT NULL
          AND auth_hold_session_generation IS NOT NULL
          AND auth_hold_worker_instance_id IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_auth_control_check'
      AND conrelid = '"__SCHEMA__".browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_auth_control_check
      CHECK (
        (auth_control_token_hash IS NULL) = (auth_control_actor_id IS NULL)
        AND (auth_control_token_hash IS NULL) = (auth_control_expires_at IS NULL)
        AND auth_control_epoch >= 0
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS browser_sessions_auth_hold_run_idx
  ON "__SCHEMA__".browser_sessions (auth_hold_run_id)
  WHERE auth_hold_run_id IS NOT NULL;

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
CROSS JOIN (VALUES ('session:view'), ('session:control')) AS p(permission)
WHERE r.key IN ('admin', 'author', 'operator')
ON CONFLICT DO NOTHING;
