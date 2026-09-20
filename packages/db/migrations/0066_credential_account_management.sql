-- 目标账号凭据管理：角色授权的目标范围、目录墓碑和批次幂等。
ALTER TABLE __SCHEMA__.console_account_roles ADD COLUMN IF NOT EXISTS target_scope_mode text NOT NULL DEFAULT 'none' CHECK (target_scope_mode IN ('none', 'selected', 'all'));
ALTER TABLE __SCHEMA__.console_account_roles ADD COLUMN IF NOT EXISTS target_scope_ids jsonb NOT NULL DEFAULT '[]';
UPDATE __SCHEMA__.console_account_roles SET target_scope_mode = 'all' WHERE console_role_id IN (SELECT id FROM __SCHEMA__.console_roles WHERE key = 'admin' AND kind = 'system');
ALTER TABLE __SCHEMA__.credentials ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE __SCHEMA__.credential_batches ADD COLUMN IF NOT EXISTS request_digest text;
ALTER TABLE __SCHEMA__.credential_batches ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'selection';
ALTER TABLE __SCHEMA__.credential_batch_items ADD COLUMN IF NOT EXISTS request_digest text;
INSERT INTO __SCHEMA__.console_role_permissions (console_role_id, permission)
SELECT DISTINCT console_role_id, 'credential:read' FROM __SCHEMA__.console_role_permissions WHERE permission IN ('target:read', 'target:*', '*:*') ON CONFLICT DO NOTHING;
INSERT INTO __SCHEMA__.console_role_permissions (console_role_id, permission)
SELECT DISTINCT p.console_role_id, v.permission FROM __SCHEMA__.console_role_permissions p CROSS JOIN (VALUES ('credential:write'), ('credential:delete'), ('credential:import')) v(permission)
WHERE p.permission IN ('target:write', 'target:*', '*:*') ON CONFLICT DO NOTHING;
