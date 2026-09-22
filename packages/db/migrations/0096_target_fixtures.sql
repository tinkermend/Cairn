-- 0096_target_fixtures：受管测试夹具资产账本与 stored_objects fixture 外键关联
--
-- 全文幂等：重复执行不产生副作用。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".target_fixtures (
  id                            UUID        PRIMARY KEY,
  target_id                     UUID        NOT NULL
                                            REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  scenario_id                   UUID        REFERENCES "__SCHEMA__".scenarios (id) ON DELETE RESTRICT,
  name                          TEXT        NOT NULL,
  content_type                  TEXT        NOT NULL,
  byte_size                     INTEGER,
  digest                        TEXT,
  upload_generation_id          UUID,
  upload_deadline_at            TIMESTAMPTZ,
  deleted_at                    TIMESTAMPTZ,
  deleted_by                    JSONB,
  created_by_console_account_id UUID        REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'target_fixtures_byte_size_check'
      AND conrelid = '"__SCHEMA__".target_fixtures'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".target_fixtures
      ADD CONSTRAINT target_fixtures_byte_size_check
      CHECK (byte_size IS NULL OR byte_size >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS target_fixtures_target_idx
  ON "__SCHEMA__".target_fixtures (target_id, created_at);

CREATE INDEX IF NOT EXISTS target_fixtures_scenario_idx
  ON "__SCHEMA__".target_fixtures (scenario_id);

CREATE INDEX IF NOT EXISTS target_fixtures_deleted_at_idx
  ON "__SCHEMA__".target_fixtures (deleted_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '__SCHEMA__'
      AND table_name = 'stored_objects'
      AND column_name = 'fixture_id'
  ) THEN
    ALTER TABLE "__SCHEMA__".stored_objects
      ADD COLUMN fixture_id UUID REFERENCES "__SCHEMA__".target_fixtures (id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stored_objects_fixture_id_idx
  ON "__SCHEMA__".stored_objects (fixture_id);

ALTER TABLE "__SCHEMA__".stored_objects
  DROP CONSTRAINT IF EXISTS stored_objects_owner_check;

ALTER TABLE "__SCHEMA__".stored_objects
  ADD CONSTRAINT stored_objects_owner_check CHECK (
    (owner_kind = 'run' AND run_id IS NOT NULL AND artifact_id IS NULL AND fixture_id IS NULL)
    OR (owner_kind = 'artifact' AND artifact_id IS NOT NULL AND run_id IS NULL AND fixture_id IS NULL)
    OR (owner_kind = 'fixture' AND fixture_id IS NOT NULL AND run_id IS NULL AND artifact_id IS NULL)
  );
