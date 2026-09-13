-- Platform configuration current row + immutable revisions. Admin-only permissions.

CREATE TABLE platform_config (
  id TEXT NOT NULL PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  document TEXT NOT NULL,
  updated_by_console_account_id TEXT,
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bootstrap','update','restore')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (id = '00000000-0000-4000-8000-c01f16000001'),
  FOREIGN KEY (updated_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT
);

CREATE TABLE platform_config_revisions (
  id TEXT NOT NULL PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  document TEXT NOT NULL,
  actor_console_account_id TEXT,
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bootstrap','update','restore')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (actor_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX platform_config_revisions_revision_idx ON platform_config_revisions(revision);

CREATE TRIGGER platform_config_revisions_immutable BEFORE UPDATE ON platform_config_revisions BEGIN SELECT RAISE(ABORT, 'platform_config_revisions immutable'); END;

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'platform-config:read' FROM console_roles WHERE "key" = 'admin';

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'platform-config:write' FROM console_roles WHERE "key" = 'admin';
