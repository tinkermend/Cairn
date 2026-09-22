-- 0095 的 MySQL 等价增量：目标可关闭或覆盖登录后落地整理；维护 kind 增加 SETTLE_LANDING。

ALTER TABLE targets
  ADD COLUMN landing_settle_mode VARCHAR(16) NOT NULL DEFAULT 'default';

ALTER TABLE targets
  ADD COLUMN landing_settle_timeout_ms INT NULL;

ALTER TABLE session_operations
  DROP CHECK session_operations_kind_check;

ALTER TABLE session_operations
  ADD CONSTRAINT session_operations_kind_check
    CHECK (kind IN (
      'VALIDATE_AUTH_PROFILE',
      'PREPARE',
      'VERIFY_AUTH',
      'LOGIN',
      'RENEW_AUTH',
      'REFRESH_LOGIN_PAGE',
      'SETTLE_LANDING',
      'CLOSE',
      'RESTART',
      'RESET_PROFILE'
    ));
