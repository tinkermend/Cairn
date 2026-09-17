-- 0055：Target 会话策略覆盖与会话行冻结的认证驱动保活字段。

ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN session_policy JSONB,
  ADD CONSTRAINT targets_session_policy_object
    CHECK (session_policy IS NULL OR jsonb_typeof(session_policy) = 'object');

ALTER TABLE "__SCHEMA__".browser_sessions
  ADD COLUMN reclaim_mode TEXT NOT NULL DEFAULT 'IDLE',
  ADD COLUMN keep_alive_until TIMESTAMPTZ,
  ADD COLUMN keep_alive_seconds INTEGER,
  ADD COLUMN auth_probe_interval_seconds INTEGER,
  ADD COLUMN eviction_priority INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT browser_sessions_reclaim_mode_check
    CHECK (reclaim_mode IN ('IDLE', 'AUTH_DRIVEN'));

CREATE INDEX browser_sessions_keep_alive_idx
  ON "__SCHEMA__".browser_sessions (owner_worker_id, status, keep_alive_until);
