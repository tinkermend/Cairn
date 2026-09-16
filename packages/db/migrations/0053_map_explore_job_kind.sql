-- 0053：存量库把 map_jobs.job_kind 扩到 map_explore。0052 已应用的环境不会重跑当时补上的 CHECK。

ALTER TABLE "__SCHEMA__".map_jobs DROP CONSTRAINT IF EXISTS map_jobs_kind_check;
ALTER TABLE "__SCHEMA__".map_jobs
  ADD CONSTRAINT map_jobs_kind_check CHECK (job_kind IN ('map_probe','map_refresh','map_explore'));
