-- 0007_object_store：对象生命周期账本；evidences.object_key 指向 stored_objects
--
-- 全文幂等：重复执行不产生副作用。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".stored_objects (
  id                    UUID        PRIMARY KEY,
  object_key            TEXT        NOT NULL,
  run_id                UUID        NOT NULL
                                    REFERENCES "__SCHEMA__".runs (id) ON DELETE RESTRICT,
  status                TEXT        NOT NULL,
  content_type          TEXT,
  byte_size             INT,
  digest                TEXT,
  retain_until          TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at          TIMESTAMPTZ,
  purged_at             TIMESTAMPTZ,
  purge_reason          TEXT,
  purge_attempts        INT         NOT NULL DEFAULT 0,
  last_purge_error_at   TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stored_objects_status_check'
      AND conrelid = '"__SCHEMA__".stored_objects'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".stored_objects
      ADD CONSTRAINT stored_objects_status_check
      CHECK (status IN ('pending', 'available', 'purged'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stored_objects_purge_reason_check'
      AND conrelid = '"__SCHEMA__".stored_objects'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".stored_objects
      ADD CONSTRAINT stored_objects_purge_reason_check
      CHECK (purge_reason IS NULL OR purge_reason IN ('expired', 'upload_incomplete'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stored_objects_byte_size_check'
      AND conrelid = '"__SCHEMA__".stored_objects'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".stored_objects
      ADD CONSTRAINT stored_objects_byte_size_check
      CHECK (byte_size IS NULL OR byte_size >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS stored_objects_object_key_idx
  ON "__SCHEMA__".stored_objects (object_key);

CREATE INDEX IF NOT EXISTS stored_objects_purge_idx
  ON "__SCHEMA__".stored_objects (status, purge_attempts, retain_until);

CREATE INDEX IF NOT EXISTS stored_objects_pending_idx
  ON "__SCHEMA__".stored_objects (status, created_at);

CREATE INDEX IF NOT EXISTS stored_objects_run_id_idx
  ON "__SCHEMA__".stored_objects (run_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidences_object_key_stored_objects_fkey'
      AND conrelid = '"__SCHEMA__".evidences'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".evidences
      ADD CONSTRAINT evidences_object_key_stored_objects_fkey
      FOREIGN KEY (object_key) REFERENCES "__SCHEMA__".stored_objects (object_key)
      ON DELETE RESTRICT;
  END IF;
END $$;
