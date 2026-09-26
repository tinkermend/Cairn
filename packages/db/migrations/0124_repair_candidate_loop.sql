-- 0124：运行时救活沉淀为定位修复候选（repair_candidates 增加场景与生命周期字段）

ALTER TABLE "__SCHEMA__".repair_candidates
  ADD COLUMN IF NOT EXISTS scenario_id UUID,
  ADD COLUMN IF NOT EXISTS source_target_digest TEXT,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
  ADD COLUMN IF NOT EXISTS observation_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rejected_observation_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_seen_run_id UUID,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source_run_kind TEXT NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS rejection JSONB,
  ADD COLUMN IF NOT EXISTS reopen_history JSONB;

-- portability-exception: 从 JSONB patch_target_ref 回填历史存量候选的 scenario_id
UPDATE "__SCHEMA__".repair_candidates
  SET scenario_id = CAST(patch_target_ref->>'scenarioId' AS UUID)
  WHERE scenario_id IS NULL AND patch_target_ref->>'scenarioId' IS NOT NULL;

-- portability-exception: 从 JSONB patch_target_ref 回填历史存量候选的 target 摘要
UPDATE "__SCHEMA__".repair_candidates
  SET source_target_digest = COALESCE(patch_target_ref->>'sourceTargetDigest', patch_target_ref->>'sourceDefinitionDigest', 'legacy_target')
  WHERE source_target_digest IS NULL;

UPDATE "__SCHEMA__".repair_candidates
  SET dedupe_key = CAST(id AS TEXT)
  WHERE dedupe_key IS NULL;

DELETE FROM "__SCHEMA__".repair_candidates
  WHERE scenario_id IS NULL;

ALTER TABLE "__SCHEMA__".repair_candidates
  ALTER COLUMN scenario_id SET NOT NULL,
  ALTER COLUMN source_target_digest SET NOT NULL,
  ALTER COLUMN dedupe_key SET NOT NULL,
  ALTER COLUMN run_id DROP NOT NULL;

ALTER TABLE "__SCHEMA__".repair_candidates
  DROP CONSTRAINT IF EXISTS repair_candidates_run_id_fkey;

ALTER TABLE "__SCHEMA__".repair_candidates
  ADD CONSTRAINT repair_candidates_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES "__SCHEMA__".runs(id) ON DELETE SET NULL;

ALTER TABLE "__SCHEMA__".repair_candidates
  ADD CONSTRAINT repair_candidates_scenario_id_fkey
  FOREIGN KEY (scenario_id) REFERENCES "__SCHEMA__".scenarios(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS repair_candidates_scenario_id_idx
  ON "__SCHEMA__".repair_candidates (scenario_id);

CREATE INDEX IF NOT EXISTS repair_candidates_dedupe_key_idx
  ON "__SCHEMA__".repair_candidates (dedupe_key);
