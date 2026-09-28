-- 0138：workers 心跳补充磁盘总容量与崩溃/硬超时累计计数，
-- 支撑监控大盘真实磁盘使用率与浏览器崩溃/步骤硬超时展示（此前这两项在 DB 层完全没有落地列）。

ALTER TABLE "__SCHEMA__".workers
  ADD COLUMN IF NOT EXISTS sampled_disk_total_bytes bigint,
  ADD COLUMN IF NOT EXISTS sampled_browser_host_lost_count integer,
  ADD COLUMN IF NOT EXISTS sampled_step_hard_timeout_count integer;
