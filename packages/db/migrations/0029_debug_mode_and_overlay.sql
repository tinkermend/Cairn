-- 0028: Debug mode, HOLDING run status, checkpoint and debugOverlay for authoring observation.

ALTER TABLE "__SCHEMA__".runs
  DROP CONSTRAINT IF EXISTS runs_status_check;

ALTER TABLE "__SCHEMA__".runs
  ADD CONSTRAINT runs_status_check
  CHECK (status IN (
    'QUEUED', 'RUNNING', 'HOLDING', 'RECOVERING', 'WAITING_FOR_AUTH',
    'NEEDS_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELLED'
  ));

ALTER TABLE "__SCHEMA__".runs
  ADD COLUMN debug_mode TEXT NOT NULL DEFAULT 'runThrough',
  ADD COLUMN checkpoint JSONB,
  ADD COLUMN debug_overlay JSONB;

ALTER TABLE "__SCHEMA__".runs
  ADD CONSTRAINT runs_debug_mode_check
  CHECK (debug_mode IN ('runThrough', 'holdOnFailure', 'holdAfterEach', 'stepByStep'));
