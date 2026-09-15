ALTER TABLE workers ADD COLUMN internal_base_url TEXT;
ALTER TABLE workers ADD COLUMN lost_after_seconds INTEGER;
ALTER TABLE workers ADD COLUMN heartbeat_expires_at TEXT;
ALTER TABLE workers ADD COLUMN live_handle_count INTEGER;
ALTER TABLE workers ADD COLUMN sampled_slot_count INTEGER;
ALTER TABLE workers ADD COLUMN handle_mismatch_streak INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER workers_registry_check_ins BEFORE INSERT ON workers WHEN NOT (
  (NEW.lost_after_seconds IS NULL OR (typeof(NEW.lost_after_seconds) = 'integer' AND NEW.lost_after_seconds >= 1))
  AND (NEW.live_handle_count IS NULL OR (typeof(NEW.live_handle_count) = 'integer' AND NEW.live_handle_count >= 0))
  AND (NEW.sampled_slot_count IS NULL OR (typeof(NEW.sampled_slot_count) = 'integer' AND NEW.sampled_slot_count >= 0))
  AND (typeof(NEW.handle_mismatch_streak) = 'integer' AND NEW.handle_mismatch_streak BETWEEN 0 AND 2)
) BEGIN SELECT RAISE(ABORT, 'workers registry check'); END;

CREATE TRIGGER workers_registry_check_upd BEFORE UPDATE ON workers WHEN NOT (
  (NEW.lost_after_seconds IS NULL OR (typeof(NEW.lost_after_seconds) = 'integer' AND NEW.lost_after_seconds >= 1))
  AND (NEW.live_handle_count IS NULL OR (typeof(NEW.live_handle_count) = 'integer' AND NEW.live_handle_count >= 0))
  AND (NEW.sampled_slot_count IS NULL OR (typeof(NEW.sampled_slot_count) = 'integer' AND NEW.sampled_slot_count >= 0))
  AND (typeof(NEW.handle_mismatch_streak) = 'integer' AND NEW.handle_mismatch_streak BETWEEN 0 AND 2)
) BEGIN SELECT RAISE(ABORT, 'workers registry check'); END;

CREATE INDEX workers_expire_idx ON workers (status, heartbeat_expires_at);

UPDATE workers
   SET lost_after_seconds = NULL,
       heartbeat_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       internal_base_url = NULL,
       live_handle_count = NULL,
       sampled_slot_count = NULL,
       handle_mismatch_streak = 0,
       stopped_at = CASE
         WHEN status IN ('READY', 'DRAINING') THEN COALESCE(stopped_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ELSE stopped_at
       END,
       status = CASE WHEN status IN ('READY', 'DRAINING') THEN 'LOST' ELSE status END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

ALTER TABLE browser_sessions ADD COLUMN owner_worker_instance_id TEXT;

CREATE INDEX browser_sessions_owner_instance_idx
  ON browser_sessions (owner_worker_id, owner_worker_instance_id, status);
