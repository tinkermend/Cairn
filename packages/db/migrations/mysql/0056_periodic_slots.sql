-- 0072 的 MySQL 等价增量：周期任务限流槽位。

CREATE TABLE periodic_slots (
  name VARCHAR(64) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  next_due_at DATETIME(3) NOT NULL,
  claim_seq INT NOT NULL DEFAULT 0,
  lease_owner VARCHAR(256) NULL,
  lease_until DATETIME(3) NULL,
  interval_ms INT NULL,
  last_started_at DATETIME(3) NULL,
  last_finished_at DATETIME(3) NULL,
  last_duration_ms INT NULL,
  last_outcome VARCHAR(16) NULL,
  last_error_class VARCHAR(64) NULL,
  last_owner VARCHAR(256) NULL,
  PRIMARY KEY (name),
  CONSTRAINT periodic_slots_mode_check CHECK (mode IN ('single_flight', 'throttle')),
  CONSTRAINT periodic_slots_outcome_check CHECK (
    (last_outcome IS NULL) OR (last_outcome IN ('ok', 'failed'))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
