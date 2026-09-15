-- 0030: Worker 登记期限、广告入口、句柄采样与 Session 归属实例。
-- 在已停写的维护窗口使存量登记失效：不清历史心跳/实例，只注销转发资格。

ALTER TABLE "__SCHEMA__".workers
  ADD COLUMN IF NOT EXISTS internal_base_url TEXT,
  ADD COLUMN IF NOT EXISTS lost_after_seconds INT,
  ADD COLUMN IF NOT EXISTS heartbeat_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS live_handle_count INT,
  ADD COLUMN IF NOT EXISTS sampled_slot_count INT,
  ADD COLUMN IF NOT EXISTS handle_mismatch_streak INT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_lost_after_seconds_check'
      AND conrelid = '"__SCHEMA__".workers'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".workers
      ADD CONSTRAINT workers_lost_after_seconds_check
      CHECK (lost_after_seconds IS NULL OR lost_after_seconds >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_live_handle_count_check'
      AND conrelid = '"__SCHEMA__".workers'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".workers
      ADD CONSTRAINT workers_live_handle_count_check
      CHECK (live_handle_count IS NULL OR live_handle_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_sampled_slot_count_check'
      AND conrelid = '"__SCHEMA__".workers'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".workers
      ADD CONSTRAINT workers_sampled_slot_count_check
      CHECK (sampled_slot_count IS NULL OR sampled_slot_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_handle_mismatch_streak_check'
      AND conrelid = '"__SCHEMA__".workers'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".workers
      ADD CONSTRAINT workers_handle_mismatch_streak_check
      CHECK (handle_mismatch_streak BETWEEN 0 AND 2);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS workers_expire_idx
  ON "__SCHEMA__".workers (status, heartbeat_expires_at);

UPDATE "__SCHEMA__".workers
   SET lost_after_seconds = NULL,
       heartbeat_expires_at = now(),
       internal_base_url = NULL,
       live_handle_count = NULL,
       sampled_slot_count = NULL,
       handle_mismatch_streak = 0,
       status = CASE WHEN status IN ('READY', 'DRAINING') THEN 'LOST' ELSE status END,
       stopped_at = CASE
         WHEN status IN ('READY', 'DRAINING') THEN COALESCE(stopped_at, now())
         ELSE stopped_at
       END,
       updated_at = now();

ALTER TABLE "__SCHEMA__".browser_sessions
  ADD COLUMN IF NOT EXISTS owner_worker_instance_id UUID;

CREATE INDEX IF NOT EXISTS browser_sessions_owner_instance_idx
  ON "__SCHEMA__".browser_sessions (owner_worker_id, owner_worker_instance_id, status);
