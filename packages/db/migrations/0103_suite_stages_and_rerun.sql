-- 0103：场景集支持阶段编排（Stage）与局部重跑（Partial Rerun），放宽 child_run_id 可空并扩充重跑与阶段字段。

ALTER TABLE "__SCHEMA__".suite_run_items ALTER COLUMN child_run_id DROP NOT NULL;

ALTER TABLE "__SCHEMA__".suite_run_items
  ADD COLUMN IF NOT EXISTS original_run_id UUID REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS rerun_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stage_id TEXT,
  ADD COLUMN IF NOT EXISTS stage_ordinal INTEGER;
