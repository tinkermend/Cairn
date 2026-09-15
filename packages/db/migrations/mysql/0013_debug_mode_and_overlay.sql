ALTER TABLE runs
  DROP CHECK runs_status_check;

ALTER TABLE runs
  ADD CONSTRAINT runs_status_check
  CHECK ((status IN ('QUEUED', 'RUNNING', 'HOLDING', 'RECOVERING', 'WAITING_FOR_AUTH', 'NEEDS_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELLED')));

ALTER TABLE runs
  ADD COLUMN debug_mode VARCHAR(64) NOT NULL DEFAULT 'runThrough',
  ADD COLUMN checkpoint JSON,
  ADD COLUMN debug_overlay JSON;

ALTER TABLE runs
  ADD CONSTRAINT runs_debug_mode_check
  CHECK ((debug_mode IN ('runThrough', 'holdOnFailure', 'holdAfterEach', 'stepByStep')));
