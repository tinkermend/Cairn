-- 0091 的 MySQL 等价增量：初始管理员进种子数据。
--
-- 与 PostgreSQL 版同义：库迁完就有管理员，API 不再兼任开户。
-- 口令哈希为 scrypt（n=16384,r=8,p=1），格式见 packages/api/src/auth/password.ts。
-- 全文幂等：已有管理员角色账号或已有 admin 本地身份时整段跳过。

SET @admin_role_id = (SELECT id FROM console_roles WHERE `key` = 'admin' LIMIT 1);
SET @has_admin = (
  SELECT COUNT(*)
  FROM console_account_roles ar
  JOIN console_roles r ON r.id = ar.console_role_id
  WHERE r.`key` = 'admin'
);
SET @has_subject = (
  SELECT COUNT(*) FROM console_identities
  WHERE provider = 'local' AND LOWER(subject) = 'admin'
);
SET @seed = IF(@admin_role_id IS NOT NULL AND @has_admin = 0 AND @has_subject = 0, 1, 0);
SET @account_id = UUID();
SET @identity_id = UUID();

INSERT INTO console_accounts (id, display_name, email, status)
SELECT @account_id, 'Administrator', 'admin', 'active' WHERE @seed = 1;

INSERT INTO console_identities (id, console_account_id, provider, subject, secret)
SELECT @identity_id, @account_id, 'local', 'admin', '$scrypt$n=16384,r=8,p=1$wU0EAzkNrBvb8RhmSLe4DQ$9x__7KmA0TspXwF0BdpO5bgx1jsQugyCYT0pBJAw7f8' WHERE @seed = 1;

INSERT INTO console_account_roles
  (console_account_id, console_role_id, target_scope_mode, target_scope_ids)
SELECT @account_id, @admin_role_id, 'all', '[]' WHERE @seed = 1;
