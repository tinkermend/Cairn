-- 0092 的 MySQL 等价增量：控制台账号自定义头像

ALTER TABLE console_accounts
  ADD COLUMN avatar VARCHAR(256) NULL;
