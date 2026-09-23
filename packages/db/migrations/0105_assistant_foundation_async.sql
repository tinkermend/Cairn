-- 0105：平台助手异步提交、事件分片与模型调用视图增强。

ALTER TABLE "__SCHEMA__".assistant_turns
  ADD COLUMN stage TEXT,
  ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN queue_position INTEGER,
  ADD COLUMN stop_reason TEXT;

ALTER TABLE "__SCHEMA__".assistant_turns
  DROP CONSTRAINT IF EXISTS assistant_turns_status_check;

ALTER TABLE "__SCHEMA__".assistant_turns
  ADD CONSTRAINT assistant_turns_status_check
  CHECK (status IN ('QUEUED','RUNNING','CLARIFY','COMPLETED','FAILED','CANCELLED','INTERRUPTED'));

ALTER TABLE "__SCHEMA__".platform_ai_calls
  ADD COLUMN capability_version TEXT,
  ADD COLUMN context_manifest_id TEXT,
  ADD COLUMN requested_model TEXT,
  ADD COLUMN route TEXT,
  ADD COLUMN cost JSONB,
  ADD COLUMN error_class TEXT,
  ADD COLUMN validation JSONB;

CREATE TABLE "__SCHEMA__".assistant_turn_events (
  id UUID PRIMARY KEY,
  turn_id UUID NOT NULL REFERENCES "__SCHEMA__".assistant_turns(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  channel TEXT NOT NULL,
  payload JSONB NOT NULL,
  retain_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX assistant_turn_events_turn_seq_idx
  ON "__SCHEMA__".assistant_turn_events (turn_id, seq);

CREATE INDEX assistant_turn_events_retain_idx
  ON "__SCHEMA__".assistant_turn_events (retain_until);
