-- Platform configuration current row + immutable revisions. Admin-only permissions.

CREATE TABLE "__SCHEMA__".platform_config (
  id UUID NOT NULL PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  document JSONB NOT NULL,
  updated_by_console_account_id UUID REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bootstrap','update','restore')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_config_singleton CHECK (id = '00000000-0000-4000-8000-c01f16000001')
);

CREATE TABLE "__SCHEMA__".platform_config_revisions (
  id UUID NOT NULL PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  document JSONB NOT NULL,
  actor_console_account_id UUID REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bootstrap','update','restore')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX platform_config_revisions_revision_idx
  ON "__SCHEMA__".platform_config_revisions(revision);

CREATE OR REPLACE FUNCTION "__SCHEMA__".reject_platform_config_revision_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'platform_config_revisions are immutable'; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_config_revisions_immutable ON "__SCHEMA__".platform_config_revisions;
CREATE TRIGGER platform_config_revisions_immutable
  BEFORE UPDATE ON "__SCHEMA__".platform_config_revisions
  FOR EACH ROW
  EXECUTE FUNCTION "__SCHEMA__".reject_platform_config_revision_mutation();

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, 'platform-config:read'
FROM "__SCHEMA__".console_roles r
WHERE r.key = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, 'platform-config:write'
FROM "__SCHEMA__".console_roles r
WHERE r.key = 'admin'
ON CONFLICT DO NOTHING;
