-- 0061：目标账号用途。现有账号迁成 business；含地图用途的账号用 map_usage_guard 保证每目标至多一个。

ALTER TABLE "__SCHEMA__".target_accounts
  ADD COLUMN usage TEXT NOT NULL DEFAULT 'business';

ALTER TABLE "__SCHEMA__".target_accounts
  ADD COLUMN map_usage_guard TEXT;

ALTER TABLE "__SCHEMA__".target_accounts
  ADD CONSTRAINT target_accounts_usage_check CHECK (usage IN ('business', 'map', 'both'));

CREATE UNIQUE INDEX target_accounts_map_usage
  ON "__SCHEMA__".target_accounts (target_id, map_usage_guard);
