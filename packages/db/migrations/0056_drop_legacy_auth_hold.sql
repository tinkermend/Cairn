-- 0056：摘除已无生产写入的 browser_sessions.auth_hold_* 旧占用列。

ALTER TABLE "__SCHEMA__".browser_sessions
  DROP CONSTRAINT IF EXISTS browser_sessions_auth_hold_check,
  DROP CONSTRAINT IF EXISTS browser_sessions_auth_hold_binding_check;

DROP INDEX IF EXISTS "__SCHEMA__".browser_sessions_auth_hold_run_idx;

ALTER TABLE "__SCHEMA__".browser_sessions
  DROP COLUMN IF EXISTS auth_hold_worker_id,
  DROP COLUMN IF EXISTS auth_hold_expires_at,
  DROP COLUMN IF EXISTS auth_hold_run_id,
  DROP COLUMN IF EXISTS auth_hold_session_generation,
  DROP COLUMN IF EXISTS auth_hold_worker_instance_id;
