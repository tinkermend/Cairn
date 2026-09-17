-- 0055 的 MySQL 等价增量：Target 会话策略覆盖与认证驱动保活字段。

ALTER TABLE targets
  ADD COLUMN session_policy JSON,
  ADD CONSTRAINT targets_session_policy_object
    CHECK ((session_policy IS NULL) OR (LOWER(JSON_TYPE(session_policy)) = 'object'));

ALTER TABLE browser_sessions
  ADD COLUMN reclaim_mode VARCHAR(16) NOT NULL DEFAULT 'IDLE',
  ADD COLUMN keep_alive_until DATETIME(3) NULL,
  ADD COLUMN keep_alive_seconds INT NULL,
  ADD COLUMN auth_probe_interval_seconds INT NULL,
  ADD COLUMN eviction_priority INT NOT NULL DEFAULT 0,
  ADD CONSTRAINT browser_sessions_reclaim_mode_check
    CHECK (reclaim_mode IN ('IDLE', 'AUTH_DRIVEN'));

CREATE INDEX browser_sessions_keep_alive_idx
  ON browser_sessions (owner_worker_id, status, keep_alive_until);
