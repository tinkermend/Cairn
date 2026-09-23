-- 0102：场景集支持受控并发调度，移除单活唯一索引，新增执行模式与并发度列。

-- 移除原有一 SuiteRun 至多一 ACTIVE 唯一索引
DROP INDEX IF EXISTS "__SCHEMA__".suite_run_items_one_active_idx;
DROP INDEX IF EXISTS "__SCHEMA__".suite_run_items_suite_active_idx;

-- scenario_suites 表增加 execution_mode 与 max_concurrency
ALTER TABLE "__SCHEMA__".scenario_suites
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'parallel',
  ADD COLUMN IF NOT EXISTS max_concurrency INTEGER NOT NULL DEFAULT 3;

-- suite_runs 表增加 execution_mode 与 max_concurrency
ALTER TABLE "__SCHEMA__".suite_runs
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'parallel',
  ADD COLUMN IF NOT EXISTS max_concurrency INTEGER NOT NULL DEFAULT 3;
