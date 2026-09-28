-- 0137：替换 runs_target_created_idx 为带 INCLUDE 覆盖列的 runs_target_created_outcome_idx，支撑监控大盘目标系统 SLA 聚合

DROP INDEX IF EXISTS "__SCHEMA__".runs_target_created_idx;

CREATE INDEX IF NOT EXISTS runs_target_created_outcome_idx
  ON "__SCHEMA__".runs (target_id, created_at DESC)
  INCLUDE (status, outcome_status, started_at, finished_at);
