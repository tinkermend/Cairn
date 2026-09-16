-- 0039 的 MySQL 等价增量：动作模块（Action Module）模型、版本与动作库基础表

CREATE TABLE action_modules (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  `key` VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  capability_key VARCHAR(128),
  tags JSON NOT NULL,
  aliases JSON NOT NULL,
  intent_examples JSON NOT NULL,
  draft_revision INT NOT NULL DEFAULT 0,
  draft_content JSON,
  created_by_console_account_id VARCHAR(36) NOT NULL,
  updated_by_console_account_id VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3),
  deleted_by JSON,
  CONSTRAINT action_modules_pkey PRIMARY KEY (id),
  CONSTRAINT action_modules_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT action_modules_created_by_fk FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id),
  CONSTRAINT action_modules_updated_by_fk FOREIGN KEY (updated_by_console_account_id) REFERENCES console_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX action_modules_target_key_idx ON action_modules (target_id, `key`);
CREATE INDEX action_modules_target_capability_idx ON action_modules (target_id, capability_key);
CREATE INDEX action_modules_target_id_idx ON action_modules (target_id);
CREATE INDEX action_modules_deleted_at_idx ON action_modules (deleted_at);

CREATE TABLE action_module_versions (
  id VARCHAR(36) NOT NULL,
  module_id VARCHAR(36) NOT NULL,
  version_no INT NOT NULL,
  content JSON NOT NULL,
  contract_digest VARCHAR(64) NOT NULL,
  implementation_digest VARCHAR(64) NOT NULL,
  content_digest VARCHAR(64) NOT NULL,
  compiler_version INT NOT NULL DEFAULT 1,
  execution_mode VARCHAR(32) NOT NULL,
  effect_ceiling VARCHAR(32) NOT NULL,
  publication_status VARCHAR(32) NOT NULL DEFAULT 'published',
  source_draft_revision INT,
  created_by_console_account_id VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT action_module_versions_pkey PRIMARY KEY (id),
  CONSTRAINT action_module_versions_module_fk FOREIGN KEY (module_id) REFERENCES action_modules(id),
  CONSTRAINT action_module_versions_created_by_fk FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id),
  CONSTRAINT action_module_versions_exec_mode_check CHECK (execution_mode IN ('DETERMINISTIC', 'AI', 'HYBRID')),
  CONSTRAINT action_module_versions_effect_ceiling_check CHECK (effect_ceiling IN ('READ_ONLY', 'IDEMPOTENT', 'SIDE_EFFECT')),
  CONSTRAINT action_module_versions_pub_status_check CHECK (publication_status IN ('published', 'deprecated', 'withdrawn'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX action_module_versions_module_version_idx ON action_module_versions (module_id, version_no);
CREATE INDEX action_module_versions_module_pub_idx ON action_module_versions (module_id, publication_status);
CREATE INDEX action_module_versions_module_id_idx ON action_module_versions (module_id);

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
JOIN (
  SELECT 'admin' AS role_key, 'module:read' AS permission
  UNION ALL SELECT 'admin', 'module:write'
  UNION ALL SELECT 'admin', 'module:publish'
  UNION ALL SELECT 'author', 'module:read'
  UNION ALL SELECT 'author', 'module:write'
  UNION ALL SELECT 'author', 'module:publish'
  UNION ALL SELECT 'operator', 'module:read'
) p ON p.role_key = r.`key`
WHERE r.kind = 'system';
