-- 0043 的 MySQL 等价增量：运行中认证检查点

ALTER TABLE runs
  ADD COLUMN auth_checkpoint JSON NULL;
