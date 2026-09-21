-- 冻结分析来源及作业输入；已有记录由有界补录修复。
ALTER TABLE "__SCHEMA__".analysis_source_index ADD COLUMN IF NOT EXISTS snapshot JSONB;
ALTER TABLE "__SCHEMA__".analysis_jobs ADD COLUMN IF NOT EXISTS input_snapshot JSONB;
ALTER TABLE "__SCHEMA__".analysis_job_attempts ADD COLUMN IF NOT EXISTS model_usage JSONB;
