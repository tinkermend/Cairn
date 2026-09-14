-- Per-run event ledger and high-water mark for observation / SSE catch-up.

ALTER TABLE "__SCHEMA__".runs
  ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "__SCHEMA__".run_events (
  event_id UUID NOT NULL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  schema_version INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  step_run_id UUID,
  attempt_id UUID,
  worker_id TEXT,
  request_id TEXT,
  payload JSONB NOT NULL
);

CREATE UNIQUE INDEX run_events_run_seq_idx
  ON "__SCHEMA__".run_events(run_id, sequence);

CREATE INDEX run_events_run_occurred_idx
  ON "__SCHEMA__".run_events(run_id, occurred_at);
