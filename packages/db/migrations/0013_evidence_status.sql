-- 0013_evidence_status：证据采集状态与 Run 证据轴。
--
-- evidences 增 status / object_id / upload_attempts。
-- status = 'missing' 当且仅当 missing_reason 非空（CHECK）。
-- runs 增 evidence_status。终态存量 Run 一律 COMPLETE，不按行回溯。
--
-- 全文幂等：重复执行不产生副作用。

ALTER TABLE "__SCHEMA__".evidences
  ADD COLUMN IF NOT EXISTS status TEXT;

ALTER TABLE "__SCHEMA__".evidences
  ADD COLUMN IF NOT EXISTS object_id UUID;

ALTER TABLE "__SCHEMA__".evidences
  ADD COLUMN IF NOT EXISTS upload_attempts INT NOT NULL DEFAULT 0;

UPDATE "__SCHEMA__".evidences
SET status = CASE
  WHEN missing_reason IS NOT NULL THEN 'missing'
  ELSE 'available'
END
WHERE status IS NULL;

ALTER TABLE "__SCHEMA__".evidences
  ALTER COLUMN status SET DEFAULT 'available';

ALTER TABLE "__SCHEMA__".evidences
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidences_status_check'
      AND conrelid = '"__SCHEMA__".evidences'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".evidences
      ADD CONSTRAINT evidences_status_check
      CHECK (status IN ('pending', 'available', 'missing'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidences_status_missing_reason_check'
      AND conrelid = '"__SCHEMA__".evidences'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".evidences
      ADD CONSTRAINT evidences_status_missing_reason_check
      CHECK (
        (status = 'missing' AND missing_reason IS NOT NULL)
        OR (status <> 'missing' AND missing_reason IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidences_upload_attempts_check'
      AND conrelid = '"__SCHEMA__".evidences'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".evidences
      ADD CONSTRAINT evidences_upload_attempts_check
      CHECK (upload_attempts >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidences_object_id_stored_objects_fkey'
      AND conrelid = '"__SCHEMA__".evidences'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".evidences
      ADD CONSTRAINT evidences_object_id_stored_objects_fkey
      FOREIGN KEY (object_id) REFERENCES "__SCHEMA__".stored_objects (id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS evidences_status_idx
  ON "__SCHEMA__".evidences (status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS evidences_run_incomplete_idx
  ON "__SCHEMA__".evidences (run_id)
  WHERE type = 'error' AND payload->>'code' = 'EVIDENCE_INCOMPLETE';

ALTER TABLE "__SCHEMA__".runs
  ADD COLUMN IF NOT EXISTS evidence_status TEXT;

UPDATE "__SCHEMA__".runs
SET evidence_status = CASE
  WHEN status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN 'COMPLETE'
  ELSE 'PENDING'
END
WHERE evidence_status IS NULL;

ALTER TABLE "__SCHEMA__".runs
  ALTER COLUMN evidence_status SET DEFAULT 'PENDING';

ALTER TABLE "__SCHEMA__".runs
  ALTER COLUMN evidence_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_evidence_status_check'
      AND conrelid = '"__SCHEMA__".runs'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".runs
      ADD CONSTRAINT runs_evidence_status_check
      CHECK (evidence_status IN ('PENDING', 'COMPLETE', 'INCOMPLETE'));
  END IF;
END $$;
