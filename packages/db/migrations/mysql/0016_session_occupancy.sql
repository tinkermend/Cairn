-- 0032 的 MySQL 等价增量：租约用途化、操作账本、Profile 登记、协议能力。

ALTER TABLE session_leases
  ADD COLUMN purpose VARCHAR(32) NOT NULL DEFAULT 'EXECUTION',
  ADD COLUMN owner_kind VARCHAR(32) NOT NULL DEFAULT 'RUN',
  ADD COLUMN operation_id VARCHAR(36),
  ADD COLUMN wait_deadline_at DATETIME(3);

ALTER TABLE session_leases
  MODIFY run_id VARCHAR(36) NULL;

UPDATE session_leases
   SET purpose = 'EXECUTION',
       owner_kind = 'RUN';

ALTER TABLE session_leases
  DROP CHECK session_leases_run_fencing_active_check;

ALTER TABLE session_leases
  ADD CONSTRAINT session_leases_owner_xor_check
    CHECK (
      (owner_kind = 'RUN' AND run_id IS NOT NULL AND operation_id IS NULL)
      OR (owner_kind = 'SESSION_OPERATION' AND operation_id IS NOT NULL AND run_id IS NULL)
    ),
  ADD CONSTRAINT session_leases_purpose_owner_check
    CHECK (
      (purpose = 'EXECUTION' AND owner_kind = 'RUN')
      OR (purpose = 'MAINTENANCE' AND owner_kind = 'SESSION_OPERATION')
      OR purpose = 'AUTH_WAIT'
    ),
  ADD CONSTRAINT session_leases_purpose_check
    CHECK (purpose IN ('EXECUTION', 'MAINTENANCE', 'AUTH_WAIT')),
  ADD CONSTRAINT session_leases_owner_kind_check
    CHECK (owner_kind IN ('RUN', 'SESSION_OPERATION')),
  ADD CONSTRAINT session_leases_wait_deadline_check
    CHECK ((purpose = 'AUTH_WAIT') = (wait_deadline_at IS NOT NULL)),
  ADD CONSTRAINT session_leases_run_fencing_purpose_check
    CHECK (
      (status <> 'ACTIVE')
      OR (purpose <> 'EXECUTION')
      OR (run_fencing_token IS NOT NULL)
    );

CREATE INDEX session_leases_operation_id_idx ON session_leases (operation_id);
CREATE INDEX session_leases_wait_deadline_idx ON session_leases (status, wait_deadline_at);

CREATE TABLE session_operations (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36) NOT NULL,
  kind VARCHAR(64) NOT NULL,
  kind_params JSON NOT NULL,
  origin VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  expected_session_id VARCHAR(36),
  expected_generation INT,
  idempotency_key VARCHAR(256) NOT NULL,
  content_digest VARCHAR(64) NOT NULL,
  auth_rule_revision INT,
  account_config_digest VARCHAR(64),
  secret_refs JSON NOT NULL,
  resource_policy JSON,
  platform_config_revision INT NOT NULL,
  queue_deadline_at DATETIME(3) NOT NULL,
  claim_token VARCHAR(128),
  owner_worker_id VARCHAR(256),
  owner_worker_instance_id VARCHAR(36),
  attempt_no INT NOT NULL DEFAULT 0,
  error_code VARCHAR(64),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3),
  CONSTRAINT session_operations_pkey PRIMARY KEY (id),
  CONSTRAINT session_operations_kind_check CHECK (kind IN ('VALIDATE_AUTH_PROFILE')),
  CONSTRAINT session_operations_origin_check CHECK (origin IN ('USER', 'BACKGROUND')),
  CONSTRAINT session_operations_status_check
    CHECK (status IN ('QUEUED', 'RUNNING', 'WAITING_FOR_AUTH', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  CONSTRAINT session_operations_attempt_check CHECK (attempt_no >= 0),
  CONSTRAINT session_operations_terminal_check
    CHECK ((status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) = (finished_at IS NOT NULL)),
  CONSTRAINT session_operations_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT session_operations_target_account_fkey
    FOREIGN KEY (target_account_id, target_id) REFERENCES target_accounts(id, target_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX session_operations_idempotency_idx
  ON session_operations (target_id, target_account_id, idempotency_key);
CREATE INDEX session_operations_claim_idx ON session_operations (status, created_at);
CREATE INDEX session_operations_key_idx ON session_operations (target_id, target_account_id, status);

CREATE TABLE session_profiles (
  target_id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36) NOT NULL,
  revision INT NOT NULL,
  location_worker_id VARCHAR(256),
  state VARCHAR(32) NOT NULL,
  pending_cleanups JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT session_profiles_pkey PRIMARY KEY (target_id, target_account_id),
  CONSTRAINT session_profiles_revision_check CHECK (revision >= 1),
  CONSTRAINT session_profiles_state_check CHECK (state IN ('ABSENT', 'PRESENT')),
  CONSTRAINT session_profiles_target_account_fkey
    FOREIGN KEY (target_account_id, target_id) REFERENCES target_accounts(id, target_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

ALTER TABLE workers
  ADD COLUMN protocol_capabilities JSON NOT NULL DEFAULT (JSON_ARRAY());

ALTER TABLE session_leases
  ADD CONSTRAINT session_leases_operation_id_fkey
    FOREIGN KEY (operation_id) REFERENCES session_operations(id) ON DELETE RESTRICT;
