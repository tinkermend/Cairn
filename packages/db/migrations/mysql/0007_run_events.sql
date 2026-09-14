-- Per-run event ledger and high-water mark for observation / SSE catch-up.

ALTER TABLE runs
  ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE run_events (
  event_id VARCHAR(36) NOT NULL PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  schema_version INTEGER NOT NULL DEFAULT 1,
  type VARCHAR(64) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  step_run_id VARCHAR(36),
  attempt_id VARCHAR(36),
  worker_id VARCHAR(128),
  request_id VARCHAR(128),
  payload JSON NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX run_events_run_seq_idx ON run_events(run_id, sequence);
CREATE INDEX run_events_run_occurred_idx ON run_events(run_id, occurred_at);
