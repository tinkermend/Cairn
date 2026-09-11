-- 0009_session_dispose：browser-sessions 控制面权限（读取 / 人工处置）
--
-- 权限目录由 @cairn/shared 拥有，库里只存角色→权限的绑定。
-- 系统角色是代码定义的固定集合，所以新增权限码必须在这里补种，
-- 否则 admin 登录后 `RequirePermissions('session:dispose')` 会 403，
-- 而 shared 的单测（admin 覆盖整个目录）与实际库内容不一致。
--
-- 全文幂等：重复执行不产生副作用。

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
JOIN (VALUES
  -- admin：目录内全部权限，新增码必须跟齐
  ('admin', 'session:read'),
  ('admin', 'session:dispose'),
  -- operator：与 SYSTEM_ROLE_DEFINITIONS.operator 同步
  ('operator', 'session:read'),
  ('operator', 'session:dispose'),
  -- viewer：只读
  ('viewer', 'session:read')
) AS p(role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
