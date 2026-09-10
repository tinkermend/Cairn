-- 0006_execution：场景版本、Run 账本、StepRun / Attempt / Evidence
--
-- Snapshot 整份 JSONB 存在 runs.snapshot。快照列与版本 definition 禁止改写。
-- 领取索引与幂等部分唯一索引见 runs。
--
-- 全文幂等：重复执行不产生副作用。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".scenarios (
  id                              UUID        PRIMARY KEY,
  target_id                       UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  name                            TEXT        NOT NULL,
  status                          TEXT        NOT NULL DEFAULT 'active',
  created_by_console_account_id   UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scenarios_status_check'
      AND conrelid = '"__SCHEMA__".scenarios'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".scenarios
      ADD CONSTRAINT scenarios_status_check
      CHECK (status IN ('active', 'disabled'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS scenarios_target_name_idx
  ON "__SCHEMA__".scenarios (target_id, name);

CREATE INDEX IF NOT EXISTS scenarios_target_id_idx
  ON "__SCHEMA__".scenarios (target_id);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".scenario_versions (
  id                              UUID        PRIMARY KEY,
  scenario_id                     UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".scenarios (id) ON DELETE RESTRICT,
  version_no                      INT         NOT NULL,
  definition                      JSONB       NOT NULL,
  created_by_console_account_id   UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scenario_versions_no_check'
      AND conrelid = '"__SCHEMA__".scenario_versions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".scenario_versions
      ADD CONSTRAINT scenario_versions_no_check
      CHECK (version_no >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scenario_versions_definition_object'
      AND conrelid = '"__SCHEMA__".scenario_versions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".scenario_versions
      ADD CONSTRAINT scenario_versions_definition_object
      CHECK (jsonb_typeof(definition) = 'object');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS scenario_versions_scenario_no_idx
  ON "__SCHEMA__".scenario_versions (scenario_id, version_no);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".runs (
  id                              UUID        PRIMARY KEY,
  target_id                       UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  scenario_id                     UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".scenarios (id) ON DELETE RESTRICT,
  scenario_version_id             UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".scenario_versions (id) ON DELETE RESTRICT,
  target_account_id               UUID
                                              REFERENCES "__SCHEMA__".target_accounts (id) ON DELETE RESTRICT,
  created_by_console_account_id   UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  status                          TEXT        NOT NULL,
  cancel_requested_at             TIMESTAMPTZ,
  started_at                      TIMESTAMPTZ,
  finished_at                     TIMESTAMPTZ,
  snapshot                        JSONB       NOT NULL,
  snapshot_digest                 TEXT        NOT NULL,
  context                         JSONB       NOT NULL,
  idempotency_key                 TEXT,
  idempotency_digest              TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_status_check'
      AND conrelid = '"__SCHEMA__".runs'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".runs
      ADD CONSTRAINT runs_status_check
      CHECK (status IN (
        'QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH',
        'NEEDS_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELLED'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_idempotency_pair'
      AND conrelid = '"__SCHEMA__".runs'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".runs
      ADD CONSTRAINT runs_idempotency_pair
      CHECK ((idempotency_key IS NULL) = (idempotency_digest IS NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_idx
  ON "__SCHEMA__".runs (created_by_console_account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS runs_claim_idx
  ON "__SCHEMA__".runs (status, created_at, id);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".step_runs (
  id            UUID        PRIMARY KEY,
  run_id        UUID        NOT NULL
                            REFERENCES "__SCHEMA__".runs (id) ON DELETE RESTRICT,
  step_id       UUID        NOT NULL,
  ordinal       INT         NOT NULL,
  status        TEXT        NOT NULL,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'step_runs_ordinal_check'
      AND conrelid = '"__SCHEMA__".step_runs'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".step_runs
      ADD CONSTRAINT step_runs_ordinal_check
      CHECK (ordinal >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'step_runs_status_check'
      AND conrelid = '"__SCHEMA__".step_runs'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".step_runs
      ADD CONSTRAINT step_runs_status_check
      CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS step_runs_run_step_idx
  ON "__SCHEMA__".step_runs (run_id, step_id);

CREATE UNIQUE INDEX IF NOT EXISTS step_runs_run_ordinal_idx
  ON "__SCHEMA__".step_runs (run_id, ordinal);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".attempts (
  id            UUID        PRIMARY KEY,
  step_run_id   UUID        NOT NULL
                            REFERENCES "__SCHEMA__".step_runs (id) ON DELETE RESTRICT,
  attempt_no    INT         NOT NULL,
  status        TEXT        NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  output        JSONB,
  error         JSONB
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attempts_no_check'
      AND conrelid = '"__SCHEMA__".attempts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".attempts
      ADD CONSTRAINT attempts_no_check
      CHECK (attempt_no >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attempts_status_check'
      AND conrelid = '"__SCHEMA__".attempts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".attempts
      ADD CONSTRAINT attempts_status_check
      CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS attempts_step_no_idx
  ON "__SCHEMA__".attempts (step_run_id, attempt_no);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".evidences (
  id              UUID        PRIMARY KEY,
  run_id          UUID        NOT NULL
                              REFERENCES "__SCHEMA__".runs (id) ON DELETE RESTRICT,
  step_run_id     UUID
                              REFERENCES "__SCHEMA__".step_runs (id) ON DELETE RESTRICT,
  attempt_id      UUID
                              REFERENCES "__SCHEMA__".attempts (id) ON DELETE RESTRICT,
  type            TEXT        NOT NULL,
  schema_version  INT         NOT NULL DEFAULT 1,
  payload         JSONB,
  object_key      TEXT,
  content_type    TEXT,
  byte_size       INT,
  digest          TEXT,
  missing_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidences_type_check'
      AND conrelid = '"__SCHEMA__".evidences'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".evidences
      ADD CONSTRAINT evidences_type_check
      CHECK (type IN ('input', 'output', 'error', 'screenshot', 'log', 'trace'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS evidences_run_created_idx
  ON "__SCHEMA__".evidences (run_id, created_at);

CREATE INDEX IF NOT EXISTS evidences_attempt_id_idx
  ON "__SCHEMA__".evidences (attempt_id);

CREATE OR REPLACE FUNCTION "__SCHEMA__".reject_scenario_version_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.definition IS DISTINCT FROM NEW.definition
     OR OLD.version_no IS DISTINCT FROM NEW.version_no
     OR OLD.scenario_id IS DISTINCT FROM NEW.scenario_id
  THEN
    RAISE EXCEPTION 'scenario_versions definition is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scenario_versions_immutable ON "__SCHEMA__".scenario_versions;
CREATE TRIGGER scenario_versions_immutable
  BEFORE UPDATE ON "__SCHEMA__".scenario_versions
  FOR EACH ROW
  EXECUTE FUNCTION "__SCHEMA__".reject_scenario_version_mutation();

CREATE OR REPLACE FUNCTION "__SCHEMA__".reject_run_snapshot_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.snapshot IS DISTINCT FROM NEW.snapshot
     OR OLD.snapshot_digest IS DISTINCT FROM NEW.snapshot_digest
     OR OLD.target_id IS DISTINCT FROM NEW.target_id
     OR OLD.scenario_id IS DISTINCT FROM NEW.scenario_id
     OR OLD.scenario_version_id IS DISTINCT FROM NEW.scenario_version_id
  THEN
    RAISE EXCEPTION 'runs snapshot fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS runs_snapshot_immutable ON "__SCHEMA__".runs;
CREATE TRIGGER runs_snapshot_immutable
  BEFORE UPDATE ON "__SCHEMA__".runs
  FOR EACH ROW
  EXECUTE FUNCTION "__SCHEMA__".reject_run_snapshot_mutation();

CREATE OR REPLACE FUNCTION "__SCHEMA__".reject_closed_attempt_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
    IF OLD.status IS DISTINCT FROM NEW.status
       OR OLD.output IS DISTINCT FROM NEW.output
       OR OLD.error IS DISTINCT FROM NEW.error
       OR OLD.finished_at IS DISTINCT FROM NEW.finished_at
    THEN
      RAISE EXCEPTION 'closed attempt is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attempts_closed_immutable ON "__SCHEMA__".attempts;
CREATE TRIGGER attempts_closed_immutable
  BEFORE UPDATE ON "__SCHEMA__".attempts
  FOR EACH ROW
  EXECUTE FUNCTION "__SCHEMA__".reject_closed_attempt_mutation();
