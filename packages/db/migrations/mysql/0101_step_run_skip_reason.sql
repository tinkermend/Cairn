-- PostgreSQL 0117 的 MySQL 等价增量：CF-A 步骤跳过原因（step_runs.skip_reason）。

ALTER TABLE step_runs
  ADD COLUMN skip_reason VARCHAR(64) NULL;
