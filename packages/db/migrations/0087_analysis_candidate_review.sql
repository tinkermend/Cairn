-- 人工采纳候选的版本和去向；不改变分析作业结果或发布版本。
ALTER TABLE "__SCHEMA__".analysis_candidates ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "__SCHEMA__".analysis_candidates ADD COLUMN review JSONB;
