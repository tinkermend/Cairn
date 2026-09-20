-- 0071 的 MySQL 等价增量：Target 级显式验证码定位器配置（图形/滑块）。
-- 未配置时运行期继续走内置指纹库自动探测；null 语义与 login_fields 一致。

ALTER TABLE targets
  ADD COLUMN captcha JSON NULL;
