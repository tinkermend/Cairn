-- 0010_admin_login_account：默认管理员从邮箱标识改为账号 admin
--
-- 登录名存在两处：console_accounts.email 与 local identity 的 subject。
-- 引导只在「还没有 admin 角色账号」时写入，已有库不会自动改名，所以这里改数据。
--
-- 全文幂等：只改 admin@cairn.dev；已是 admin 或冲突时不动。

UPDATE "__SCHEMA__".console_accounts
SET email = 'admin', updated_at = now()
WHERE lower(email) = 'admin@cairn.dev'
  AND NOT EXISTS (
    SELECT 1
    FROM "__SCHEMA__".console_accounts other
    WHERE other.id <> console_accounts.id
      AND lower(other.email) = 'admin'
  );

UPDATE "__SCHEMA__".console_identities
SET subject = 'admin'
WHERE provider = 'local'
  AND lower(subject) = 'admin@cairn.dev'
  AND NOT EXISTS (
    SELECT 1
    FROM "__SCHEMA__".console_identities other
    WHERE other.id <> console_identities.id
      AND other.provider = 'local'
      AND lower(other.subject) = 'admin'
  );
