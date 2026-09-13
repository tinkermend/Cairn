-- 0017 的 SQLite 等价增量：admin 获得 ai:execute。

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'ai:execute' FROM console_roles WHERE key = 'admin';
