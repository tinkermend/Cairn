ALTER TABLE workers
  ADD COLUMN internal_base_url TEXT,
  ADD COLUMN lost_after_seconds INT,
  ADD COLUMN heartbeat_expires_at DATETIME(3),
  ADD COLUMN live_handle_count INT,
  ADD COLUMN sampled_slot_count INT,
  ADD COLUMN handle_mismatch_streak INT NOT NULL DEFAULT 0,
  ADD CONSTRAINT workers_lost_after_seconds_check
    CHECK ((lost_after_seconds IS NULL) OR (lost_after_seconds >= 1)),
  ADD CONSTRAINT workers_live_handle_count_check
    CHECK ((live_handle_count IS NULL) OR (live_handle_count >= 0)),
  ADD CONSTRAINT workers_sampled_slot_count_check
    CHECK ((sampled_slot_count IS NULL) OR (sampled_slot_count >= 0)),
  ADD CONSTRAINT workers_handle_mismatch_streak_check
    CHECK ((handle_mismatch_streak BETWEEN 0 AND 2));

CREATE INDEX workers_expire_idx ON workers (status, heartbeat_expires_at);

UPDATE workers
   SET lost_after_seconds = NULL,
       heartbeat_expires_at = CURRENT_TIMESTAMP(3),
       internal_base_url = NULL,
       live_handle_count = NULL,
       sampled_slot_count = NULL,
       handle_mismatch_streak = 0,
       stopped_at = CASE
         WHEN status IN ('READY', 'DRAINING') THEN COALESCE(stopped_at, CURRENT_TIMESTAMP(3))
         ELSE stopped_at
       END,
       status = CASE WHEN status IN ('READY', 'DRAINING') THEN 'LOST' ELSE status END,
       updated_at = CURRENT_TIMESTAMP(3);

ALTER TABLE browser_sessions
  ADD COLUMN owner_worker_instance_id VARCHAR(36);

CREATE INDEX browser_sessions_owner_instance_idx
  ON browser_sessions (owner_worker_id, owner_worker_instance_id, status);
