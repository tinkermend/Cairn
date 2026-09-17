-- 0056 的 MySQL 等价增量：摘除 browser_sessions.auth_hold_* 旧占用列。
-- 顺序：先外键，再约束与索引，最后列。

ALTER TABLE browser_sessions
  DROP FOREIGN KEY browser_sessions_auth_hold_run_fkey;

ALTER TABLE browser_sessions
  DROP CHECK browser_sessions_auth_hold_check,
  DROP CHECK browser_sessions_auth_hold_binding_check;

DROP INDEX browser_sessions_auth_hold_run_idx ON browser_sessions;

ALTER TABLE browser_sessions
  DROP COLUMN auth_hold_worker_id,
  DROP COLUMN auth_hold_expires_at,
  DROP COLUMN auth_hold_run_id,
  DROP COLUMN auth_hold_session_generation,
  DROP COLUMN auth_hold_worker_instance_id;
