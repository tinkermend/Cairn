-- 0014_recording_drafts：录制上传草稿。IR 不是 Runtime 事实源，不进正式调度。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".recording_drafts (
  id                              UUID        PRIMARY KEY,
  target_id                       UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  created_by_console_account_id   UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  recording_id                    UUID        NOT NULL,
  source_version                  TEXT        NOT NULL,
  idempotency_key                 TEXT        NOT NULL,
  payload_digest                  TEXT        NOT NULL,
  name                            TEXT        NOT NULL,
  event_count                     INTEGER     NOT NULL,
  item_count                      INTEGER     NOT NULL,
  unresolved_count                INTEGER     NOT NULL,
  events                          JSONB       NOT NULL,
  items                           JSONB       NOT NULL,
  diagnostics                     JSONB       NOT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'recording_drafts_events_array'
      AND conrelid = '"__SCHEMA__".recording_drafts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".recording_drafts
      ADD CONSTRAINT recording_drafts_events_array
      CHECK (jsonb_typeof(events) = 'array');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'recording_drafts_items_array'
      AND conrelid = '"__SCHEMA__".recording_drafts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".recording_drafts
      ADD CONSTRAINT recording_drafts_items_array
      CHECK (jsonb_typeof(items) = 'array');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'recording_drafts_diagnostics_array'
      AND conrelid = '"__SCHEMA__".recording_drafts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".recording_drafts
      ADD CONSTRAINT recording_drafts_diagnostics_array
      CHECK (jsonb_typeof(diagnostics) = 'array');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS recording_drafts_actor_idempotency_idx
  ON "__SCHEMA__".recording_drafts (created_by_console_account_id, idempotency_key);

CREATE INDEX IF NOT EXISTS recording_drafts_target_id_idx
  ON "__SCHEMA__".recording_drafts (target_id);

CREATE INDEX IF NOT EXISTS recording_drafts_created_at_idx
  ON "__SCHEMA__".recording_drafts (created_at);
