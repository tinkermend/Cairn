-- 0102 的 MySQL 等价增量：场景集支持受控并发调度，移除单活唯一索引，新增执行模式与并发度列。

-- 移除单活唯一索引
ALTER TABLE suite_run_items DROP INDEX suite_run_items_one_active_idx;

-- scenario_suites 表增加 execution_mode 与 max_concurrency
ALTER TABLE scenario_suites
  ADD COLUMN execution_mode VARCHAR(32) NOT NULL DEFAULT 'parallel',
  ADD COLUMN max_concurrency INT NOT NULL DEFAULT 3;

-- suite_runs 表增加 execution_mode 与 max_concurrency
ALTER TABLE suite_runs
  ADD COLUMN execution_mode VARCHAR(32) NOT NULL DEFAULT 'parallel',
  ADD COLUMN max_concurrency INT NOT NULL DEFAULT 3;
