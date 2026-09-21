-- PostgreSQL 0087 的等价增量。
ALTER TABLE analysis_candidates ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE analysis_candidates ADD COLUMN review JSON NULL;
