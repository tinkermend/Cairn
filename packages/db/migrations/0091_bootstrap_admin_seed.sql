-- 0091_bootstrap_admin_seed：初始管理员进种子数据
--
-- 在此之前，首位管理员由 API 的 BootstrapService 在空库时现场创建，口令是
-- 代码里的常量。那样「交付时有没有管理员」取决于 API 起没起过、起的是哪个版本；
-- 现在改成迁移的一部分：库迁完就有管理员，控制面只管鉴权，不再兼任开户。
--
-- 口令哈希是 scrypt（n=16384,r=8,p=1），与 packages/api/src/auth/password.ts 同格式，
-- 对应口令与当前交付约定一致（账号 admin）。首次登录后应立即在控制台改密。
--
-- 全文幂等：已存在任一管理员角色账号时整段跳过，不改名、不改密、不重复建号。

DO $$
DECLARE
  admin_role_id UUID;
  new_account_id UUID;
BEGIN
  -- 已经有人持管理员角色就什么都不做：升级库不能被种子数据覆盖。
  IF EXISTS (
    SELECT 1
    FROM "__SCHEMA__".console_account_roles ar
    JOIN "__SCHEMA__".console_roles r ON r.id = ar.console_role_id
    WHERE r.key = 'admin'
  ) THEN
    RETURN;
  END IF;

  SELECT id INTO admin_role_id FROM "__SCHEMA__".console_roles WHERE key = 'admin';
  IF admin_role_id IS NULL THEN
    RAISE EXCEPTION '系统角色 admin 缺失（0002_rbac 未执行？）';
  END IF;

  -- 登录名同样不能撞：有人已占用 admin 这个 subject 就让位，不抢。
  IF EXISTS (
    SELECT 1 FROM "__SCHEMA__".console_identities
    WHERE provider = 'local' AND lower(subject) = 'admin'
  ) THEN
    RETURN;
  END IF;

  new_account_id := gen_random_uuid();

  INSERT INTO "__SCHEMA__".console_accounts (id, display_name, email, status)
  VALUES (new_account_id, 'Administrator', 'admin', 'active');

  INSERT INTO "__SCHEMA__".console_identities (id, console_account_id, provider, subject, secret)
  VALUES (gen_random_uuid(), new_account_id, 'local', 'admin', '$scrypt$n=16384,r=8,p=1$wU0EAzkNrBvb8RhmSLe4DQ$9x__7KmA0TspXwF0BdpO5bgx1jsQugyCYT0pBJAw7f8');

  INSERT INTO "__SCHEMA__".console_account_roles
    (console_account_id, console_role_id, target_scope_mode, target_scope_ids)
  VALUES (new_account_id, admin_role_id, 'all', '[]');
END $$;
