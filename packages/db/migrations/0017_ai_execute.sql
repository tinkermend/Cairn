-- 0017_ai_execute：admin 获得浏览器仿真 AI 执行权限
--
-- operator / viewer 默认不授予。系统角色权限集由代码拥有，本迁移只补库里的 admin 行。
-- 全文幂等：重复执行不产生副作用。

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, 'ai:execute'
FROM "__SCHEMA__".console_roles r
WHERE r.key = 'admin'
ON CONFLICT DO NOTHING;
