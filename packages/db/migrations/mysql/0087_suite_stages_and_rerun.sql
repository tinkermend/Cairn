-- 0103 的 MySQL 等价增量：场景集支持阶段编排（Stage）与局部重跑（Partial Rerun）。

ALTER TABLE suite_run_items
  MODIFY child_run_id VARCHAR(36) NULL,
  ADD COLUMN original_run_id VARCHAR(36) NULL,
  ADD COLUMN rerun_count INT NOT NULL DEFAULT 0,
  ADD COLUMN stage_id VARCHAR(64) NULL,
  ADD COLUMN stage_ordinal INT NULL;

ALTER TABLE suite_run_items
  ADD CONSTRAINT suite_run_items_original_run_fk FOREIGN KEY (original_run_id) REFERENCES runs(id) ON DELETE RESTRICT;
