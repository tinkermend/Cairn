ALTER TABLE browser_sessions ADD COLUMN auth_hold_run_id TEXT REFERENCES runs(id);
ALTER TABLE browser_sessions ADD COLUMN auth_hold_session_generation INTEGER;
ALTER TABLE browser_sessions ADD COLUMN auth_hold_worker_instance_id TEXT;
ALTER TABLE browser_sessions ADD COLUMN auth_control_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_sessions ADD COLUMN auth_control_actor_id TEXT REFERENCES console_accounts(id);
ALTER TABLE browser_sessions ADD COLUMN auth_control_token_hash TEXT;
ALTER TABLE browser_sessions ADD COLUMN auth_control_expires_at TEXT;
ALTER TABLE browser_sessions ADD COLUMN auth_control_page_id TEXT;

CREATE INDEX IF NOT EXISTS browser_sessions_auth_hold_run_idx
  ON browser_sessions (auth_hold_run_id);

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, 'session:view' FROM console_roles r WHERE r.key IN ('admin', 'author', 'operator');

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, 'session:control' FROM console_roles r WHERE r.key IN ('admin', 'author', 'operator');
