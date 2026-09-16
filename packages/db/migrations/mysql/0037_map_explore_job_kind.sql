-- 0053 的 MySQL 等价增量：存量库把 map_jobs.job_kind 扩到 map_explore。

ALTER TABLE map_jobs DROP CHECK map_jobs_kind_check;
ALTER TABLE map_jobs
  ADD CONSTRAINT map_jobs_kind_check CHECK (job_kind IN ('map_probe','map_refresh','map_explore'));
