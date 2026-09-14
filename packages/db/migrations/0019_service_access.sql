-- Controlled execution credentials. Keys never contain console permissions.

CREATE TABLE "__SCHEMA__".service_callers (
  id UUID NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  requests_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (requests_per_minute BETWEEN 1 AND 600),
  max_outstanding_runs INTEGER NOT NULL DEFAULT 2 CHECK (max_outstanding_runs BETWEEN 1 AND 20),
  run_timeout_seconds INTEGER NOT NULL DEFAULT 600 CHECK (run_timeout_seconds BETWEEN 1 AND 3600),
  window_started_at TIMESTAMPTZ,
  window_requests INTEGER NOT NULL DEFAULT 0 CHECK (window_requests >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "__SCHEMA__".service_credentials (
  id UUID NOT NULL PRIMARY KEY,
  caller_id UUID NOT NULL,
  name TEXT NOT NULL,
  secret_digest TEXT NOT NULL,
  scopes JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_by_console_account_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (caller_id) REFERENCES "__SCHEMA__".service_callers(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_console_account_id) REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX service_credentials_caller_id_idx ON "__SCHEMA__".service_credentials(caller_id,id);

CREATE UNIQUE INDEX target_accounts_target_id_pair_idx ON "__SCHEMA__".target_accounts(target_id,id);

CREATE TABLE "__SCHEMA__".credential_target_grants (
  credential_id UUID NOT NULL,
  target_id UUID NOT NULL,
  allow_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (allow_anonymous IN (0,1)),
  PRIMARY KEY (credential_id,target_id),
  FOREIGN KEY (credential_id) REFERENCES "__SCHEMA__".service_credentials(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT
);

CREATE TABLE "__SCHEMA__".credential_target_account_grants (
  credential_id UUID NOT NULL,
  target_id UUID NOT NULL,
  target_account_id UUID NOT NULL,
  PRIMARY KEY (credential_id,target_id,target_account_id),
  FOREIGN KEY (credential_id,target_id) REFERENCES "__SCHEMA__".credential_target_grants(credential_id,target_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id,target_account_id) REFERENCES "__SCHEMA__".target_accounts(target_id,id) ON DELETE RESTRICT
);

CREATE INDEX credential_account_target_idx ON "__SCHEMA__".credential_target_account_grants(target_id,target_account_id);

ALTER TABLE "__SCHEMA__".runs ALTER COLUMN created_by_console_account_id DROP NOT NULL;

ALTER TABLE "__SCHEMA__".runs ADD COLUMN service_caller_id UUID;

ALTER TABLE "__SCHEMA__".runs ADD COLUMN service_credential_id UUID;

ALTER TABLE "__SCHEMA__".runs ADD COLUMN service_admission JSONB;

ALTER TABLE "__SCHEMA__".runs ADD COLUMN deadline_at TIMESTAMPTZ;

ALTER TABLE "__SCHEMA__".runs ADD COLUMN cancel_reason TEXT;

ALTER TABLE "__SCHEMA__".runs ADD CONSTRAINT runs_actor_shape CHECK ((created_by_console_account_id IS NOT NULL AND service_caller_id IS NULL AND service_credential_id IS NULL AND service_admission IS NULL AND deadline_at IS NULL) OR (created_by_console_account_id IS NULL AND service_caller_id IS NOT NULL AND service_credential_id IS NOT NULL AND service_admission IS NOT NULL AND deadline_at IS NOT NULL AND idempotency_key IS NOT NULL));

ALTER TABLE "__SCHEMA__".runs ADD FOREIGN KEY (service_caller_id,service_credential_id) REFERENCES "__SCHEMA__".service_credentials(caller_id,id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX runs_idempotency_service_idx ON "__SCHEMA__".runs(service_caller_id,idempotency_key);

CREATE INDEX runs_service_status_idx ON "__SCHEMA__".runs(service_caller_id,status);

CREATE INDEX runs_deadline_idx ON "__SCHEMA__".runs(deadline_at,status);

CREATE OR REPLACE FUNCTION "__SCHEMA__".reject_run_snapshot_mutation() RETURNS trigger AS $$ BEGIN IF OLD.snapshot IS DISTINCT FROM NEW.snapshot OR OLD.snapshot_digest IS DISTINCT FROM NEW.snapshot_digest OR OLD.target_id IS DISTINCT FROM NEW.target_id OR OLD.target_account_id IS DISTINCT FROM NEW.target_account_id OR OLD.scenario_id IS DISTINCT FROM NEW.scenario_id OR OLD.scenario_version_id IS DISTINCT FROM NEW.scenario_version_id OR OLD.created_by_console_account_id IS DISTINCT FROM NEW.created_by_console_account_id OR OLD.service_caller_id IS DISTINCT FROM NEW.service_caller_id OR OLD.service_credential_id IS DISTINCT FROM NEW.service_credential_id OR OLD.service_admission IS DISTINCT FROM NEW.service_admission OR OLD.deadline_at IS DISTINCT FROM NEW.deadline_at OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.idempotency_digest IS DISTINCT FROM NEW.idempotency_digest THEN RAISE EXCEPTION '"__SCHEMA__".runs snapshot fields are immutable'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

ALTER TABLE "__SCHEMA__".evidences ADD COLUMN external_access INTEGER NOT NULL DEFAULT 0 CHECK (external_access IN (0,1));

ALTER TABLE "__SCHEMA__".console_audit_events ADD COLUMN actor_service_caller_id UUID REFERENCES "__SCHEMA__".service_callers(id);

ALTER TABLE "__SCHEMA__".console_audit_events ADD COLUMN actor_service_credential_id UUID;

ALTER TABLE "__SCHEMA__".console_audit_events ADD CONSTRAINT audit_service_actor_shape CHECK ((actor_service_caller_id IS NULL AND actor_service_credential_id IS NULL) OR (actor_console_account_id IS NULL AND actor_service_caller_id IS NOT NULL AND actor_service_credential_id IS NOT NULL AND category = 'operation'));

ALTER TABLE "__SCHEMA__".console_audit_events ADD FOREIGN KEY (actor_service_caller_id,actor_service_credential_id) REFERENCES "__SCHEMA__".service_credentials(caller_id,id);

INSERT INTO "__SCHEMA__".console_role_permissions(console_role_id,permission) SELECT id, 'service:read' FROM "__SCHEMA__".console_roles WHERE key = 'admin';

INSERT INTO "__SCHEMA__".console_role_permissions(console_role_id,permission) SELECT id, 'service:write' FROM "__SCHEMA__".console_roles WHERE key = 'admin';

ALTER TABLE "__SCHEMA__".console_audit_events ADD COLUMN request_id TEXT;
