-- Controlled execution credentials. Keys never contain console permissions.

CREATE TABLE service_callers (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  name LONGTEXT NOT NULL,
  owner LONGTEXT NOT NULL,
  status VARCHAR(256) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  requests_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (requests_per_minute BETWEEN 1 AND 600),
  max_outstanding_runs INTEGER NOT NULL DEFAULT 2 CHECK (max_outstanding_runs BETWEEN 1 AND 20),
  run_timeout_seconds INTEGER NOT NULL DEFAULT 600 CHECK (run_timeout_seconds BETWEEN 1 AND 3600),
  window_started_at DATETIME(3),
  window_requests INTEGER NOT NULL DEFAULT 0 CHECK (window_requests >= 0),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE service_credentials (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  caller_id VARCHAR(36) NOT NULL,
  name LONGTEXT NOT NULL,
  secret_digest LONGTEXT NOT NULL,
  scopes JSON NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3),
  last_used_at DATETIME(3),
  created_by_console_account_id VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (caller_id) REFERENCES service_callers(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX service_credentials_caller_id_idx ON service_credentials(caller_id,id);

CREATE UNIQUE INDEX target_accounts_target_id_pair_idx ON target_accounts(target_id,id);

CREATE TABLE credential_target_grants (
  credential_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  allow_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (allow_anonymous IN (0,1)),
  PRIMARY KEY (credential_id,target_id),
  FOREIGN KEY (credential_id) REFERENCES service_credentials(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE credential_target_account_grants (
  credential_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (credential_id,target_id,target_account_id),
  FOREIGN KEY (credential_id,target_id) REFERENCES credential_target_grants(credential_id,target_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id,target_account_id) REFERENCES target_accounts(target_id,id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX credential_account_target_idx ON credential_target_account_grants(target_id,target_account_id);

ALTER TABLE runs MODIFY created_by_console_account_id VARCHAR(36) NULL;

ALTER TABLE runs ADD COLUMN service_caller_id VARCHAR(36);

ALTER TABLE runs ADD COLUMN service_credential_id VARCHAR(36);

ALTER TABLE runs ADD COLUMN service_admission JSON;

ALTER TABLE runs ADD COLUMN deadline_at DATETIME(3);

ALTER TABLE runs ADD COLUMN cancel_reason LONGTEXT;

ALTER TABLE runs ADD CONSTRAINT runs_actor_shape CHECK ((created_by_console_account_id IS NOT NULL AND service_caller_id IS NULL AND service_credential_id IS NULL AND service_admission IS NULL AND deadline_at IS NULL) OR (created_by_console_account_id IS NULL AND service_caller_id IS NOT NULL AND service_credential_id IS NOT NULL AND service_admission IS NOT NULL AND deadline_at IS NOT NULL AND idempotency_key IS NOT NULL));

ALTER TABLE runs ADD FOREIGN KEY (service_caller_id,service_credential_id) REFERENCES service_credentials(caller_id,id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX runs_idempotency_service_idx ON runs(service_caller_id,idempotency_key);

CREATE INDEX runs_service_status_idx ON runs(service_caller_id,status);

CREATE INDEX runs_deadline_idx ON runs(deadline_at,status);

DROP TRIGGER runs_snapshot_immutable;

CREATE TRIGGER runs_snapshot_immutable BEFORE UPDATE ON runs FOR EACH ROW BEGIN IF NOT (OLD.snapshot <=> NEW.snapshot) OR NOT (OLD.snapshot_digest <=> NEW.snapshot_digest) OR NOT (OLD.target_id <=> NEW.target_id) OR NOT (OLD.target_account_id <=> NEW.target_account_id) OR NOT (OLD.scenario_id <=> NEW.scenario_id) OR NOT (OLD.scenario_version_id <=> NEW.scenario_version_id) OR NOT (OLD.created_by_console_account_id <=> NEW.created_by_console_account_id) OR NOT (OLD.service_caller_id <=> NEW.service_caller_id) OR NOT (OLD.service_credential_id <=> NEW.service_credential_id) OR NOT (OLD.service_admission <=> NEW.service_admission) OR NOT (OLD.deadline_at <=> NEW.deadline_at) OR NOT (OLD.idempotency_key <=> NEW.idempotency_key) OR NOT (OLD.idempotency_digest <=> NEW.idempotency_digest) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'runs immutable'; END IF; END;

ALTER TABLE evidences ADD COLUMN external_access INTEGER NOT NULL DEFAULT 0 CHECK (external_access IN (0,1));

ALTER TABLE console_audit_events ADD COLUMN actor_service_caller_id VARCHAR(36) REFERENCES service_callers(id);

ALTER TABLE console_audit_events ADD COLUMN actor_service_credential_id VARCHAR(36);

CREATE TRIGGER audit_service_shape_insert BEFORE INSERT ON console_audit_events FOR EACH ROW BEGIN IF NOT ((NEW.actor_service_caller_id IS NULL AND NEW.actor_service_credential_id IS NULL) OR (NEW.actor_console_account_id IS NULL AND NEW.actor_service_caller_id IS NOT NULL AND NEW.actor_service_credential_id IS NOT NULL AND NEW.category = 'operation')) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit service actor mismatch'; END IF; END;

CREATE TRIGGER audit_service_shape_update BEFORE UPDATE ON console_audit_events FOR EACH ROW BEGIN IF NOT ((NEW.actor_service_caller_id IS NULL AND NEW.actor_service_credential_id IS NULL) OR (NEW.actor_console_account_id IS NULL AND NEW.actor_service_caller_id IS NOT NULL AND NEW.actor_service_credential_id IS NOT NULL AND NEW.category = 'operation')) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit service actor mismatch'; END IF; END;

ALTER TABLE console_audit_events ADD FOREIGN KEY (actor_service_caller_id,actor_service_credential_id) REFERENCES service_credentials(caller_id,id);

INSERT INTO console_role_permissions(console_role_id,permission) SELECT id, 'service:read' FROM console_roles WHERE `key` = 'admin';

INSERT INTO console_role_permissions(console_role_id,permission) SELECT id, 'service:write' FROM console_roles WHERE `key` = 'admin';

ALTER TABLE console_audit_events ADD COLUMN request_id LONGTEXT;
