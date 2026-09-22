-- 0092_account_avatar：控制台账号自定义头像
--
-- 全文幂等：重复执行不产生副作用。

ALTER TABLE "__SCHEMA__".console_accounts
  ADD COLUMN IF NOT EXISTS avatar TEXT;
