-- Platform configuration current row + immutable revisions. Admin-only permissions.

CREATE TABLE platform_config (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  document JSON NOT NULL,
  updated_by_console_account_id VARCHAR(36),
  reason LONGTEXT NOT NULL,
  source VARCHAR(32) NOT NULL CHECK (source IN ('bootstrap','update','restore')),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT platform_config_singleton CHECK (id = '00000000-0000-4000-8000-c01f16000001'),
  FOREIGN KEY (updated_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE platform_config_revisions (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  document JSON NOT NULL,
  actor_console_account_id VARCHAR(36),
  reason LONGTEXT NOT NULL,
  source VARCHAR(32) NOT NULL CHECK (source IN ('bootstrap','update','restore')),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (actor_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX platform_config_revisions_revision_idx ON platform_config_revisions(revision);

CREATE TRIGGER platform_config_revisions_immutable BEFORE UPDATE ON platform_config_revisions FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_config_revisions immutable'; END;

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'platform-config:read' FROM console_roles WHERE `key` = 'admin';

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'platform-config:write' FROM console_roles WHERE `key` = 'admin';
