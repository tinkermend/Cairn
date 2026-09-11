-- 0011_run_lease：Worker 注册、RunLease、会话 ACTIVE 行必须带 run_fencing_token、run:review 补种
--
-- 全文幂等：重复执行不产生副作用。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".workers (
  id              TEXT        PRIMARY KEY,
  instance_id     UUID        NOT NULL,
  status          TEXT        NOT NULL,
  capacity        INT         NOT NULL,
  heartbeat_at    TIMESTAMPTZ NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at      TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_status_check'
      AND conrelid = '"__SCHEMA__".workers'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".workers
      ADD CONSTRAINT workers_status_check
      CHECK (status IN ('READY', 'DRAINING', 'STOPPED', 'LOST'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_capacity_check'
      AND conrelid = '"__SCHEMA__".workers'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".workers
      ADD CONSTRAINT workers_capacity_check
      CHECK (capacity >= 1);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "__SCHEMA__".run_leases (
  id                  UUID        PRIMARY KEY,
  run_id              UUID        NOT NULL
                                  REFERENCES "__SCHEMA__".runs (id) ON DELETE RESTRICT,
  fencing_token       INT         NOT NULL,
  holder_worker_id    TEXT        NOT NULL,
  status              TEXT        NOT NULL,
  acquired_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  released_at         TIMESTAMPTZ,
  release_reason      TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'run_leases_status_check'
      AND conrelid = '"__SCHEMA__".run_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".run_leases
      ADD CONSTRAINT run_leases_status_check
      CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'run_leases_released_check'
      AND conrelid = '"__SCHEMA__".run_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".run_leases
      ADD CONSTRAINT run_leases_released_check
      CHECK ((status = 'ACTIVE') = (released_at IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'run_leases_token_check'
      AND conrelid = '"__SCHEMA__".run_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".run_leases
      ADD CONSTRAINT run_leases_token_check
      CHECK (fencing_token >= 1);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS run_leases_active_idx
  ON "__SCHEMA__".run_leases (run_id)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS run_leases_token_idx
  ON "__SCHEMA__".run_leases (run_id, fencing_token);

CREATE INDEX IF NOT EXISTS run_leases_holder_idx
  ON "__SCHEMA__".run_leases (holder_worker_id, status);

CREATE INDEX IF NOT EXISTS run_leases_reap_idx
  ON "__SCHEMA__".run_leases (status, expires_at)
  WHERE status = 'ACTIVE';

-- ACTIVE 会话租约必须带当前 Run fencing；历史非 ACTIVE 的 NULL 可留
--
-- 加约束前必须先收掉存量的 ACTIVE + NULL 行。0008 的 run_fencing_token 可空，
-- 本次之前写入的会话租约一律是 NULL；而下面是校验型 CHECK，PostgreSQL 会扫全表，
-- 撞上一行就报 23514 并把整份迁移回滚——升级路径直接断掉。
-- Worker 被 kill 后残留的 ACTIVE 行没有进程去回收（reaper 在 Worker 里），会一直留着，
-- 所以这不是理论情况。这些租约的持有进程早已不在，撤销是唯一诚实的处置。
UPDATE "__SCHEMA__".session_leases
   SET status = 'REVOKED',
       released_at = COALESCE(released_at, now()),
       release_reason = COALESCE(release_reason, 'pre_0011_missing_run_fencing')
 WHERE status = 'ACTIVE'
   AND run_fencing_token IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_run_fencing_active_check'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      ADD CONSTRAINT session_leases_run_fencing_active_check
      CHECK (status <> 'ACTIVE' OR run_fencing_token IS NOT NULL);
  END IF;
END $$;

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
JOIN (VALUES
  ('admin', 'run:review'),
  ('operator', 'run:review')
) AS p(role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
