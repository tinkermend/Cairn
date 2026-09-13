-- 0017 的 MySQL 等价增量：admin 获得 ai:execute。

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'ai:execute' FROM console_roles WHERE `key` = 'admin';
