-- 0117：CF-A 步骤跳过原因（step_runs.skip_reason）

ALTER TABLE "__SCHEMA__".step_runs
  ADD COLUMN IF NOT EXISTS skip_reason TEXT;
