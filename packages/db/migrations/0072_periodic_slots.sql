-- 0072：周期任务限流槽位。行由启动时 insertIgnore 建立，不需要种子。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".periodic_slots (
  name TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  next_due_at TIMESTAMPTZ NOT NULL,
  claim_seq INT NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  interval_ms INT,
  last_started_at TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_duration_ms INT,
  last_outcome TEXT,
  last_error_class TEXT,
  last_owner TEXT,
  CONSTRAINT periodic_slots_name_len_check CHECK (char_length(name) <= 64),
  CONSTRAINT periodic_slots_mode_check CHECK (mode IN ('single_flight', 'throttle')),
  CONSTRAINT periodic_slots_outcome_check CHECK (
    last_outcome IS NULL OR last_outcome IN ('ok', 'failed')
  )
);
