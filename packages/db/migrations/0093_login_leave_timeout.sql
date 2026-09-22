-- 0093：目标系统可覆盖提交后等待离开登录页的时间；空则用平台 sessionAuth.loginLeaveTimeoutMs。

ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN IF NOT EXISTS login_leave_timeout_ms INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'targets_login_leave_timeout_ms_positive'
      AND conrelid = '"__SCHEMA__".targets'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".targets
      ADD CONSTRAINT targets_login_leave_timeout_ms_positive
      CHECK (login_leave_timeout_ms IS NULL OR login_leave_timeout_ms > 0);
  END IF;
END $$;
