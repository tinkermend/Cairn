-- 0015_scenario_drafts：场景草稿、版本 kind，以及试跑去重。

ALTER TABLE "__SCHEMA__".scenario_versions
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS compiler_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS source_digest TEXT;

UPDATE "__SCHEMA__".scenario_versions
   SET source_digest = md5(definition::text)
 WHERE source_digest IS NULL;

ALTER TABLE "__SCHEMA__".scenario_versions
  ALTER COLUMN source_digest SET NOT NULL,
  ALTER COLUMN version_no DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scenario_versions_kind_check'
      AND conrelid = '"__SCHEMA__".scenario_versions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".scenario_versions
      ADD CONSTRAINT scenario_versions_kind_check
      CHECK (kind IN ('published', 'trial'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scenario_versions_published_no_check'
      AND conrelid = '"__SCHEMA__".scenario_versions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".scenario_versions
      ADD CONSTRAINT scenario_versions_published_no_check
      CHECK ((kind = 'published' AND version_no IS NOT NULL) OR (kind = 'trial' AND version_no IS NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS scenario_versions_trial_digest_idx
  ON "__SCHEMA__".scenario_versions (scenario_id, source_digest)
  WHERE kind = 'trial';

CREATE TABLE IF NOT EXISTS "__SCHEMA__".scenario_drafts (
  scenario_id                     UUID        PRIMARY KEY
                                              REFERENCES "__SCHEMA__".scenarios (id) ON DELETE RESTRICT,
  revision                        INTEGER     NOT NULL,
  document                        JSONB       NOT NULL,
  updated_by_console_account_id   UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scenario_drafts_revision_check'
      AND conrelid = '"__SCHEMA__".scenario_drafts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".scenario_drafts
      ADD CONSTRAINT scenario_drafts_revision_check
      CHECK (revision >= 1);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scenario_drafts_document_object'
      AND conrelid = '"__SCHEMA__".scenario_drafts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".scenario_drafts
      ADD CONSTRAINT scenario_drafts_document_object
      CHECK (jsonb_typeof(document) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS scenario_drafts_updated_at_idx
  ON "__SCHEMA__".scenario_drafts (updated_at);

INSERT INTO "__SCHEMA__".scenario_drafts (
  scenario_id, revision, document, updated_by_console_account_id, updated_at
)
SELECT
  s.id,
  1,
  CASE
    WHEN v.definition ? 'inputs' THEN v.definition
    ELSE jsonb_set(v.definition, '{inputs}', '[]'::jsonb)
  END,
  s.created_by_console_account_id,
  s.updated_at
FROM "__SCHEMA__".scenarios s
JOIN LATERAL (
  SELECT definition
    FROM "__SCHEMA__".scenario_versions
   WHERE scenario_id = s.id AND kind = 'published'
   ORDER BY version_no DESC
   LIMIT 1
) v ON TRUE
ON CONFLICT (scenario_id) DO NOTHING;

CREATE OR REPLACE FUNCTION "__SCHEMA__".reject_scenario_version_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.definition IS DISTINCT FROM NEW.definition
     OR OLD.version_no IS DISTINCT FROM NEW.version_no
     OR OLD.scenario_id IS DISTINCT FROM NEW.scenario_id
     OR OLD.kind IS DISTINCT FROM NEW.kind
     OR OLD.compiler_version IS DISTINCT FROM NEW.compiler_version
     OR OLD.source_digest IS DISTINCT FROM NEW.source_digest
  THEN
    RAISE EXCEPTION 'scenario_versions definition is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
