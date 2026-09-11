-- 0008_browser_session：BrowserSession / SessionLease
--
-- 生命周期 / 健康 / 认证三列分离；活会话键部分唯一索引；ACTIVE 租约部分唯一索引。
-- 全文幂等：重复执行不产生副作用。

-- 复合外键需要被引用侧唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS target_accounts_id_target_id_idx
  ON "__SCHEMA__".target_accounts (id, target_id);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".browser_sessions (
  id                      UUID        PRIMARY KEY,
  target_id               UUID        NOT NULL,
  target_account_id       UUID        NOT NULL,
  status                  TEXT        NOT NULL,
  health                  TEXT        NOT NULL DEFAULT 'UNKNOWN',
  auth_state              TEXT        NOT NULL DEFAULT 'UNKNOWN',
  owner_worker_id         TEXT        NOT NULL,
  generation              INT         NOT NULL,
  fencing_token           INT         NOT NULL DEFAULT 0,
  version                 INT         NOT NULL DEFAULT 0,
  profile_key             TEXT        NOT NULL,
  reuse_policy            TEXT        NOT NULL,
  idle_ttl_seconds        INT         NOT NULL,
  max_lifetime_seconds    INT         NOT NULL,
  expires_at              TIMESTAMPTZ NOT NULL,
  last_used_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  auth_hold_worker_id     TEXT,
  auth_hold_expires_at    TIMESTAMPTZ,
  close_reason            TEXT,
  closed_at               TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT browser_sessions_target_account_fkey
    FOREIGN KEY (target_account_id, target_id)
    REFERENCES "__SCHEMA__".target_accounts (id, target_id)
    ON DELETE RESTRICT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_status_check'
      AND conrelid = '"__SCHEMA__".browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_status_check
      CHECK (status IN ('CREATING', 'OPEN', 'CLOSING', 'CLOSED', 'LOST'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_health_check'
      AND conrelid = '"__SCHEMA__".browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_health_check
      CHECK (health IN ('UNKNOWN', 'HEALTHY', 'UNHEALTHY'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_auth_state_check'
      AND conrelid = '"__SCHEMA__".browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_auth_state_check
      CHECK (auth_state IN ('UNKNOWN', 'AUTHENTICATED', 'EXPIRED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_reuse_policy_check'
      AND conrelid = '"__SCHEMA__".browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_reuse_policy_check
      CHECK (reuse_policy IN ('REUSE_PAGE', 'NEW_PAGE', 'RECREATE_SESSION'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_auth_hold_check'
      AND conrelid = '"__SCHEMA__".browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_auth_hold_check
      CHECK ((auth_hold_worker_id IS NULL) = (auth_hold_expires_at IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_closed_check'
      AND conrelid = '"__SCHEMA__".browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_closed_check
      CHECK (status <> 'CLOSED' OR (closed_at IS NOT NULL AND close_reason IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_ttl_check'
      AND conrelid = '"__SCHEMA__".browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_ttl_check
      CHECK (idle_ttl_seconds > 0 AND max_lifetime_seconds > idle_ttl_seconds);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_generation_check'
      AND conrelid = '"__SCHEMA__".browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_generation_check
      CHECK (generation >= 1 AND fencing_token >= 0 AND version >= 0);
  END IF;
END $$;

-- 活会话键唯一：CLOSED 是唯一释放键的终态；LOST 仍占键，防同账号双开
CREATE UNIQUE INDEX IF NOT EXISTS browser_sessions_key_live_idx
  ON "__SCHEMA__".browser_sessions (target_id, target_account_id)
  WHERE status IN ('CREATING', 'OPEN', 'CLOSING', 'LOST');

CREATE INDEX IF NOT EXISTS browser_sessions_owner_idx
  ON "__SCHEMA__".browser_sessions (owner_worker_id, status);

CREATE INDEX IF NOT EXISTS browser_sessions_reap_idx
  ON "__SCHEMA__".browser_sessions (status, last_used_at)
  WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS "__SCHEMA__".session_leases (
  id                        UUID        PRIMARY KEY,
  session_id                UUID        NOT NULL
                                        REFERENCES "__SCHEMA__".browser_sessions (id) ON DELETE RESTRICT,
  session_generation        INT         NOT NULL,
  session_fencing_token     INT         NOT NULL,
  run_id                    UUID        NOT NULL
                                        REFERENCES "__SCHEMA__".runs (id) ON DELETE RESTRICT,
  run_fencing_token         INT,
  holder_worker_id          TEXT        NOT NULL,
  status                    TEXT        NOT NULL,
  acquired_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                TIMESTAMPTZ NOT NULL,
  released_at               TIMESTAMPTZ,
  release_reason            TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_status_check'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      ADD CONSTRAINT session_leases_status_check
      CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_released_check'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      ADD CONSTRAINT session_leases_released_check
      CHECK ((status = 'ACTIVE') = (released_at IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_fencing_check'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      ADD CONSTRAINT session_leases_fencing_check
      CHECK (
        session_generation >= 1
        AND session_fencing_token >= 1
        AND (run_fencing_token IS NULL OR run_fencing_token >= 1)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS session_leases_active_idx
  ON "__SCHEMA__".session_leases (session_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS session_leases_reap_idx
  ON "__SCHEMA__".session_leases (status, expires_at)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS session_leases_run_id_idx
  ON "__SCHEMA__".session_leases (run_id);

CREATE INDEX IF NOT EXISTS session_leases_holder_idx
  ON "__SCHEMA__".session_leases (holder_worker_id, status);
