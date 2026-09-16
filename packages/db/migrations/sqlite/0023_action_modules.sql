-- 0039 的 SQLite 等价增量：动作模块（Action Module）模型、版本与动作库基础表

CREATE TABLE action_modules (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  capability_key TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  aliases TEXT NOT NULL DEFAULT '[]',
  intent_examples TEXT NOT NULL DEFAULT '[]',
  draft_revision INTEGER NOT NULL DEFAULT 0,
  draft_content TEXT,
  created_by_console_account_id TEXT NOT NULL,
  updated_by_console_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  deleted_by TEXT,
  CONSTRAINT action_modules_pkey PRIMARY KEY (id),
  CONSTRAINT action_modules_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT action_modules_created_by_fk FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT action_modules_updated_by_fk FOREIGN KEY (updated_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX action_modules_target_key_idx ON action_modules (target_id, key);
CREATE INDEX action_modules_target_capability_idx ON action_modules (target_id, capability_key);
CREATE INDEX action_modules_target_id_idx ON action_modules (target_id);
CREATE INDEX action_modules_deleted_at_idx ON action_modules (deleted_at);

CREATE TABLE action_module_versions (
  id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  content TEXT NOT NULL,
  contract_digest TEXT NOT NULL,
  implementation_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  compiler_version INTEGER NOT NULL DEFAULT 1,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('DETERMINISTIC', 'AI', 'HYBRID')),
  effect_ceiling TEXT NOT NULL CHECK (effect_ceiling IN ('READ_ONLY', 'IDEMPOTENT', 'SIDE_EFFECT')),
  publication_status TEXT NOT NULL DEFAULT 'published' CHECK (publication_status IN ('published', 'deprecated', 'withdrawn')),
  source_draft_revision INTEGER,
  created_by_console_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT action_module_versions_pkey PRIMARY KEY (id),
  CONSTRAINT action_module_versions_module_fk FOREIGN KEY (module_id) REFERENCES action_modules(id) ON DELETE RESTRICT,
  CONSTRAINT action_module_versions_created_by_fk FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX action_module_versions_module_version_idx ON action_module_versions (module_id, version_no);
CREATE INDEX action_module_versions_module_pub_idx ON action_module_versions (module_id, publication_status);
CREATE INDEX action_module_versions_module_id_idx ON action_module_versions (module_id);

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
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
) AS p ON p.role_key = r.key
WHERE r.kind = 'system';
