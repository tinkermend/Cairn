-- 0061 的 MySQL 等价增量：目标账号用途与每目标至多一个采集号。
-- `usage` 是 MySQL 保留字，必须加反引号。

ALTER TABLE target_accounts
  ADD COLUMN `usage` VARCHAR(16) NOT NULL DEFAULT 'business';

ALTER TABLE target_accounts
  ADD COLUMN map_usage_guard VARCHAR(1) NULL;

ALTER TABLE target_accounts
  ADD CONSTRAINT target_accounts_usage_check CHECK (`usage` IN ('business', 'map', 'both'));

ALTER TABLE target_accounts
  ADD UNIQUE KEY target_accounts_map_usage (target_id, map_usage_guard);
