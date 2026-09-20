-- 目标账号凭据管理；普通授权默认无目标范围，管理员明确全范围。
ALTER TABLE console_account_roles ADD COLUMN target_scope_mode varchar(16) NOT NULL DEFAULT 'none' CHECK (target_scope_mode IN ('none', 'selected', 'all'));
ALTER TABLE console_account_roles ADD COLUMN target_scope_ids json NOT NULL DEFAULT ('[]');
UPDATE console_account_roles ar JOIN console_roles r ON ar.console_role_id = r.id SET ar.target_scope_mode = 'all' WHERE r.`key` = 'admin' AND r.kind = 'system';
ALTER TABLE credentials ADD COLUMN deleted_at datetime(3) NULL;
ALTER TABLE credential_batches ADD COLUMN request_digest text NULL;
ALTER TABLE credential_batches ADD COLUMN source varchar(16) NOT NULL DEFAULT 'selection';
ALTER TABLE credential_batch_items ADD COLUMN request_digest text NULL;
INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT DISTINCT console_role_id, 'credential:read' FROM console_role_permissions WHERE permission IN ('target:read', 'target:*', '*:*');
INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT DISTINCT p.console_role_id, v.permission FROM console_role_permissions p CROSS JOIN (SELECT 'credential:write' AS permission UNION ALL SELECT 'credential:delete' UNION ALL SELECT 'credential:import') v
WHERE p.permission IN ('target:write', 'target:*', '*:*');
