-- 冻结分析来源及作业输入，与 PostgreSQL 0086 等价。
ALTER TABLE analysis_source_index ADD COLUMN snapshot JSON NULL;
ALTER TABLE analysis_jobs ADD COLUMN input_snapshot JSON NULL;
ALTER TABLE analysis_job_attempts ADD COLUMN model_usage JSON NULL;
