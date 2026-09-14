ALTER TABLE browser_sessions
  ADD COLUMN auth_hold_run_id VARCHAR(36) NULL,
  ADD COLUMN auth_hold_session_generation INT NULL,
  ADD COLUMN auth_hold_worker_instance_id VARCHAR(36) NULL,
  ADD COLUMN auth_control_epoch INT NOT NULL DEFAULT 0,
  ADD COLUMN auth_control_actor_id VARCHAR(36) NULL,
  ADD COLUMN auth_control_token_hash LONGTEXT NULL,
  ADD COLUMN auth_control_expires_at DATETIME(3) NULL,
  ADD COLUMN auth_control_page_id VARCHAR(36) NULL;

ALTER TABLE browser_sessions
  ADD CONSTRAINT browser_sessions_auth_hold_run_fkey
    FOREIGN KEY (auth_hold_run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT browser_sessions_auth_control_actor_fkey
    FOREIGN KEY (auth_control_actor_id) REFERENCES console_accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT browser_sessions_auth_hold_binding_check
    CHECK (
      (auth_hold_run_id IS NULL AND auth_hold_session_generation IS NULL AND auth_hold_worker_instance_id IS NULL)
      OR (
        auth_hold_worker_id IS NOT NULL
        AND auth_hold_run_id IS NOT NULL
        AND auth_hold_session_generation IS NOT NULL
        AND auth_hold_worker_instance_id IS NOT NULL
      )
    ),
  ADD CONSTRAINT browser_sessions_auth_control_check
    CHECK (
      (auth_control_token_hash IS NULL) = (auth_control_actor_id IS NULL)
      AND (auth_control_token_hash IS NULL) = (auth_control_expires_at IS NULL)
      AND auth_control_epoch >= 0
    );

CREATE INDEX browser_sessions_auth_hold_run_idx ON browser_sessions (auth_hold_run_id);

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
CROSS JOIN (
  SELECT 'session:view' AS permission
  UNION ALL
  SELECT 'session:control'
) p
WHERE r.`key` IN ('admin', 'author', 'operator');
