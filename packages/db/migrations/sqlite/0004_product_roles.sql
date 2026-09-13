-- 0018 的 SQLite 等价增量：产品角色。

INSERT INTO console_roles (id, key, name, kind)
SELECT '00000000-0000-4000-8000-ffffffffffff', 'author_conflict', 'x', 'invalid'
WHERE EXISTS (SELECT 1 FROM console_roles WHERE key = 'author' AND kind <> 'system');

INSERT OR IGNORE INTO console_roles (id, key, name, description, kind)
VALUES (
  '7c3d1e2a-4b5f-4a80-9c1d-2e6f8a0b4c5d',
  'author',
  '编写者',
  '登记目标、编写场景、试跑，也能创建正式 Run。不管账号与角色。',
  'system'
);

UPDATE console_roles SET
  name = '管理员',
  description = '治理与全部业务能力，包括身份与权限管理。'
WHERE key = 'admin';

UPDATE console_roles SET
  name = '编写者',
  description = '登记目标、编写场景、试跑，也能创建正式 Run。不管账号与角色。'
WHERE key = 'author';

UPDATE console_roles SET
  name = '执行者',
  description = '选目标账号、发起 / 取消 / 核查运行。不改场景定义，不管身份。'
WHERE key = 'operator';

UPDATE console_roles SET
  name = '只读',
  description = '查看目标、场景、运行与证据。不能写，不能开跑。'
WHERE key = 'viewer';

DELETE FROM console_role_permissions
WHERE console_role_id IN (SELECT id FROM console_roles WHERE kind = 'system');

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
JOIN (
  SELECT 'admin' AS role_key, 'account:read' AS permission
  UNION ALL SELECT 'admin', 'account:write'
  UNION ALL SELECT 'admin', 'account:delete'
  UNION ALL SELECT 'admin', 'role:read'
  UNION ALL SELECT 'admin', 'role:write'
  UNION ALL SELECT 'admin', 'role:delete'
  UNION ALL SELECT 'admin', 'workflow:read'
  UNION ALL SELECT 'admin', 'workflow:write'
  UNION ALL SELECT 'admin', 'workflow:delete'
  UNION ALL SELECT 'admin', 'run:read'
  UNION ALL SELECT 'admin', 'run:execute'
  UNION ALL SELECT 'admin', 'run:cancel'
  UNION ALL SELECT 'admin', 'run:review'
  UNION ALL SELECT 'admin', 'session:read'
  UNION ALL SELECT 'admin', 'session:dispose'
  UNION ALL SELECT 'admin', 'target:read'
  UNION ALL SELECT 'admin', 'target:write'
  UNION ALL SELECT 'admin', 'target:delete'
  UNION ALL SELECT 'admin', 'settings:read'
  UNION ALL SELECT 'admin', 'settings:write'
  UNION ALL SELECT 'admin', 'audit:read'
  UNION ALL SELECT 'admin', 'audit:login'
  UNION ALL SELECT 'admin', 'ai:execute'
  UNION ALL SELECT 'author', 'target:read'
  UNION ALL SELECT 'author', 'target:write'
  UNION ALL SELECT 'author', 'target:delete'
  UNION ALL SELECT 'author', 'workflow:read'
  UNION ALL SELECT 'author', 'workflow:write'
  UNION ALL SELECT 'author', 'workflow:delete'
  UNION ALL SELECT 'author', 'run:read'
  UNION ALL SELECT 'author', 'run:execute'
  UNION ALL SELECT 'author', 'run:cancel'
  UNION ALL SELECT 'author', 'run:review'
  UNION ALL SELECT 'author', 'ai:execute'
  UNION ALL SELECT 'author', 'session:read'
  UNION ALL SELECT 'author', 'settings:read'
  UNION ALL SELECT 'operator', 'target:read'
  UNION ALL SELECT 'operator', 'workflow:read'
  UNION ALL SELECT 'operator', 'run:read'
  UNION ALL SELECT 'operator', 'run:execute'
  UNION ALL SELECT 'operator', 'run:cancel'
  UNION ALL SELECT 'operator', 'run:review'
  UNION ALL SELECT 'operator', 'ai:execute'
  UNION ALL SELECT 'operator', 'session:read'
  UNION ALL SELECT 'operator', 'session:dispose'
  UNION ALL SELECT 'operator', 'settings:read'
  UNION ALL SELECT 'viewer', 'target:read'
  UNION ALL SELECT 'viewer', 'workflow:read'
  UNION ALL SELECT 'viewer', 'run:read'
  UNION ALL SELECT 'viewer', 'settings:read'
) AS p ON p.role_key = r.key;
