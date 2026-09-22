-- 0093 的 MySQL 等价增量：目标系统可覆盖提交后等待离开登录页的时间。

ALTER TABLE targets
  ADD COLUMN login_leave_timeout_ms INT NULL;
