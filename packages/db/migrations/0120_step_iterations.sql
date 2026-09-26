-- 0120：CF-C 循环迭代与步骤作用域路径（step_runs.scope_path, step_iterations）

ALTER TABLE "__SCHEMA__".step_runs
  ADD COLUMN IF NOT EXISTS scope_path TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "__SCHEMA__".step_runs_run_step_idx;
DROP INDEX IF EXISTS "__SCHEMA__".step_runs_run_ordinal_idx;

CREATE UNIQUE INDEX IF NOT EXISTS step_runs_run_step_scope_idx
  ON "__SCHEMA__".step_runs (run_id, step_id, scope_path);

CREATE UNIQUE INDEX IF NOT EXISTS step_runs_run_ordinal_scope_idx
  ON "__SCHEMA__".step_runs (run_id, ordinal, scope_path);

CREATE INDEX IF NOT EXISTS step_runs_run_scope_idx
  ON "__SCHEMA__".step_runs (run_id, scope_path);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".step_iterations (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE CASCADE,
  block_id UUID NOT NULL,
  header_step_id UUID NOT NULL,
  scope_path TEXT NOT NULL,
  iteration_index INT NOT NULL,
  status TEXT NOT NULL,
  item JSONB,
  frame JSONB NOT NULL DEFAULT '{}'::jsonb,
  stop_decision JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS step_iterations_run_block_scope_iter_idx
  ON "__SCHEMA__".step_iterations (run_id, block_id, scope_path, iteration_index);

CREATE INDEX IF NOT EXISTS step_iterations_run_scope_idx
  ON "__SCHEMA__".step_iterations (run_id, scope_path);
