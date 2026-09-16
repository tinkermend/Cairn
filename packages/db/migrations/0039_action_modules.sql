-- 0039_action_modules：动作模块（Action Module）模型、版本与动作库基础表

CREATE TABLE "__SCHEMA__".action_modules (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  capability_key TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  intent_examples JSONB NOT NULL DEFAULT '[]'::jsonb,
  draft_revision INTEGER NOT NULL DEFAULT 0,
  draft_content JSONB,
  created_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
  updated_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by JSONB
);

CREATE UNIQUE INDEX action_modules_target_key_idx ON "__SCHEMA__".action_modules (target_id, key);
CREATE INDEX action_modules_target_capability_idx ON "__SCHEMA__".action_modules (target_id, capability_key);
CREATE INDEX action_modules_target_id_idx ON "__SCHEMA__".action_modules (target_id);
CREATE INDEX action_modules_deleted_at_idx ON "__SCHEMA__".action_modules (deleted_at);

CREATE TABLE "__SCHEMA__".action_module_versions (
  id UUID PRIMARY KEY,
  module_id UUID NOT NULL REFERENCES "__SCHEMA__".action_modules(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL,
  content JSONB NOT NULL,
  contract_digest TEXT NOT NULL,
  implementation_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  compiler_version INTEGER NOT NULL DEFAULT 1,
  execution_mode TEXT NOT NULL,
  effect_ceiling TEXT NOT NULL,
  publication_status TEXT NOT NULL DEFAULT 'published',
  source_draft_revision INTEGER,
  created_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT action_module_versions_exec_mode_check CHECK (execution_mode IN ('DETERMINISTIC', 'AI', 'HYBRID')),
  CONSTRAINT action_module_versions_effect_ceiling_check CHECK (effect_ceiling IN ('READ_ONLY', 'IDEMPOTENT', 'SIDE_EFFECT')),
  CONSTRAINT action_module_versions_pub_status_check CHECK (publication_status IN ('published', 'deprecated', 'withdrawn'))
);

CREATE UNIQUE INDEX action_module_versions_module_version_idx ON "__SCHEMA__".action_module_versions (module_id, version_no);
CREATE INDEX action_module_versions_module_pub_idx ON "__SCHEMA__".action_module_versions (module_id, publication_status);
CREATE INDEX action_module_versions_module_id_idx ON "__SCHEMA__".action_module_versions (module_id);

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
JOIN (VALUES
  ('admin', 'module:read'),
  ('admin', 'module:write'),
  ('admin', 'module:publish'),
  ('author', 'module:read'),
  ('author', 'module:write'),
  ('author', 'module:publish'),
  ('operator', 'module:read')
) AS p(role_key, permission) ON p.role_key = r.key
WHERE r.kind = 'system'
ON CONFLICT DO NOTHING;
