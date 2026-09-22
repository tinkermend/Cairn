-- 0095：目标可关闭或覆盖登录后落地整理；空则按平台 sessionAuth 默认整理。
-- 维护 kind SETTLE_LANDING 写入 session_operations 约束。

ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN IF NOT EXISTS landing_settle_mode TEXT NOT NULL DEFAULT 'default';

ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN IF NOT EXISTS landing_settle_timeout_ms INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'targets_landing_settle_mode_check'
      AND conrelid = '"__SCHEMA__".targets'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".targets
      ADD CONSTRAINT targets_landing_settle_mode_check
      CHECK (landing_settle_mode IN ('default', 'off'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'targets_landing_settle_timeout_ms_positive'
      AND conrelid = '"__SCHEMA__".targets'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".targets
      ADD CONSTRAINT targets_landing_settle_timeout_ms_positive
      CHECK (landing_settle_timeout_ms IS NULL OR landing_settle_timeout_ms > 0);
  END IF;
END $$;

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
      'SETTLE_LANDING',
      'CLOSE',
      'RESTART',
      'RESET_PROFILE'
    ));
