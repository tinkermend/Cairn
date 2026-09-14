-- Per-run event ledger and high-water mark for observation / SSE catch-up.

ALTER TABLE runs ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE run_events (
  event_id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  schema_version INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  step_run_id TEXT,
  attempt_id TEXT,
  worker_id TEXT,
  request_id TEXT,
  payload TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX run_events_run_seq_idx ON run_events(run_id, sequence);
CREATE INDEX run_events_run_occurred_idx ON run_events(run_id, occurred_at);
