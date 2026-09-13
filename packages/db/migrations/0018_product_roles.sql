-- 0018_product_roles：产品角色（管理员 / 编写者 / 执行者 / 只读）
--
-- 新增 author 系统角色；回写中文名称；四个系统角色权限行按代码目录重插。
-- 自定义角色一行不动。存量 operator 账号不自动补挂 author。
-- 全文幂等：重复执行不产生副作用。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "__SCHEMA__".console_roles
    WHERE key = 'author' AND kind <> 'system'
  ) THEN
    RAISE EXCEPTION 'console_roles.key=author already exists as a custom role; refuse to promote it to system';
  END IF;
END $$;

INSERT INTO "__SCHEMA__".console_roles (id, key, name, description, kind)
SELECT gen_random_uuid(), 'author', '编写者', '登记目标、编写场景、试跑，也能创建正式 Run。不管账号与角色。', 'system'
WHERE NOT EXISTS (
  SELECT 1 FROM "__SCHEMA__".console_roles WHERE key = 'author'
);

UPDATE "__SCHEMA__".console_roles SET
  name = '管理员',
  description = '治理与全部业务能力，包括身份与权限管理。',
  updated_at = now()
WHERE key = 'admin';

UPDATE "__SCHEMA__".console_roles SET
  name = '编写者',
  description = '登记目标、编写场景、试跑，也能创建正式 Run。不管账号与角色。',
  updated_at = now()
WHERE key = 'author';

UPDATE "__SCHEMA__".console_roles SET
  name = '执行者',
  description = '选目标账号、发起 / 取消 / 核查运行。不改场景定义，不管身份。',
  updated_at = now()
WHERE key = 'operator';

UPDATE "__SCHEMA__".console_roles SET
  name = '只读',
  description = '查看目标、场景、运行与证据。不能写，不能开跑。',
  updated_at = now()
WHERE key = 'viewer';

DELETE FROM "__SCHEMA__".console_role_permissions
WHERE console_role_id IN (
  SELECT id FROM "__SCHEMA__".console_roles WHERE kind = 'system'
);

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
JOIN (VALUES
  ('admin', 'account:read'),
  ('admin', 'account:write'),
  ('admin', 'account:delete'),
  ('admin', 'role:read'),
  ('admin', 'role:write'),
  ('admin', 'role:delete'),
  ('admin', 'workflow:read'),
  ('admin', 'workflow:write'),
  ('admin', 'workflow:delete'),
  ('admin', 'run:read'),
  ('admin', 'run:execute'),
  ('admin', 'run:cancel'),
  ('admin', 'run:review'),
  ('admin', 'session:read'),
  ('admin', 'session:dispose'),
  ('admin', 'target:read'),
  ('admin', 'target:write'),
  ('admin', 'target:delete'),
  ('admin', 'settings:read'),
  ('admin', 'settings:write'),
  ('admin', 'audit:read'),
  ('admin', 'audit:login'),
  ('admin', 'ai:execute'),
  ('author', 'target:read'),
  ('author', 'target:write'),
  ('author', 'target:delete'),
  ('author', 'workflow:read'),
  ('author', 'workflow:write'),
  ('author', 'workflow:delete'),
  ('author', 'run:read'),
  ('author', 'run:execute'),
  ('author', 'run:cancel'),
  ('author', 'run:review'),
  ('author', 'ai:execute'),
  ('author', 'session:read'),
  ('author', 'settings:read'),
  ('operator', 'target:read'),
  ('operator', 'workflow:read'),
  ('operator', 'run:read'),
  ('operator', 'run:execute'),
  ('operator', 'run:cancel'),
  ('operator', 'run:review'),
  ('operator', 'ai:execute'),
  ('operator', 'session:read'),
  ('operator', 'session:dispose'),
  ('operator', 'settings:read'),
  ('viewer', 'target:read'),
  ('viewer', 'workflow:read'),
  ('viewer', 'run:read'),
  ('viewer', 'settings:read')
) AS p(role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
