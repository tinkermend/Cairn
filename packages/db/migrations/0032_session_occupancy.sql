-- 0032：SessionLease 用途化、SessionOperation 账本、SessionProfile 登记、Worker 协议能力。
-- 破坏性迁移：存量 ACTIVE 执行租约回填 RUN/EXECUTION；auth_hold_* 只读保留。

ALTER TABLE "__SCHEMA__".session_leases
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'EXECUTION',
  ADD COLUMN IF NOT EXISTS owner_kind TEXT NOT NULL DEFAULT 'RUN',
  ADD COLUMN IF NOT EXISTS operation_id UUID,
  ADD COLUMN IF NOT EXISTS wait_deadline_at TIMESTAMPTZ;

ALTER TABLE "__SCHEMA__".session_leases
  ALTER COLUMN run_id DROP NOT NULL;

UPDATE "__SCHEMA__".session_leases
   SET purpose = 'EXECUTION',
       owner_kind = 'RUN'
 WHERE purpose IS NULL OR owner_kind IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_run_fencing_active_check'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      DROP CONSTRAINT session_leases_run_fencing_active_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_owner_xor_check'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      ADD CONSTRAINT session_leases_owner_xor_check
      CHECK (
        (owner_kind = 'RUN' AND run_id IS NOT NULL AND operation_id IS NULL)
        OR (owner_kind = 'SESSION_OPERATION' AND operation_id IS NOT NULL AND run_id IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_purpose_owner_check'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      ADD CONSTRAINT session_leases_purpose_owner_check
      CHECK (
        (purpose = 'EXECUTION' AND owner_kind = 'RUN')
        OR (purpose = 'MAINTENANCE' AND owner_kind = 'SESSION_OPERATION')
        OR purpose = 'AUTH_WAIT'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_purpose_check'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      ADD CONSTRAINT session_leases_purpose_check
      CHECK (purpose IN ('EXECUTION', 'MAINTENANCE', 'AUTH_WAIT'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_owner_kind_check'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      ADD CONSTRAINT session_leases_owner_kind_check
      CHECK (owner_kind IN ('RUN', 'SESSION_OPERATION'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_wait_deadline_check'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      ADD CONSTRAINT session_leases_wait_deadline_check
      CHECK ((purpose = 'AUTH_WAIT') = (wait_deadline_at IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_run_fencing_purpose_check'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      ADD CONSTRAINT session_leases_run_fencing_purpose_check
      CHECK (
        (status <> 'ACTIVE')
        OR (purpose <> 'EXECUTION')
        OR (run_fencing_token IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS session_leases_operation_id_idx
  ON "__SCHEMA__".session_leases (operation_id);

CREATE INDEX IF NOT EXISTS session_leases_wait_deadline_idx
  ON "__SCHEMA__".session_leases (status, wait_deadline_at)
  WHERE status = 'ACTIVE' AND purpose = 'AUTH_WAIT';

CREATE TABLE IF NOT EXISTS "__SCHEMA__".session_operations (
  id                         UUID        PRIMARY KEY,
  target_id                  UUID        NOT NULL
                                         REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  target_account_id          UUID        NOT NULL,
  kind                       TEXT        NOT NULL,
  kind_params                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  origin                     TEXT        NOT NULL,
  status                     TEXT        NOT NULL,
  expected_session_id        UUID,
  expected_generation        INT,
  idempotency_key            TEXT        NOT NULL,
  content_digest             TEXT        NOT NULL,
  auth_rule_revision         INT,
  account_config_digest      TEXT,
  secret_refs                JSONB       NOT NULL DEFAULT '[]'::jsonb,
  resource_policy            JSONB,
  platform_config_revision   INT         NOT NULL,
  queue_deadline_at          TIMESTAMPTZ NOT NULL,
  claim_token                TEXT,
  owner_worker_id            TEXT,
  owner_worker_instance_id   UUID,
  attempt_no                 INT         NOT NULL DEFAULT 0,
  error_code                 TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at                TIMESTAMPTZ,
  CONSTRAINT session_operations_kind_check
    CHECK (kind IN ('VALIDATE_AUTH_PROFILE')),
  CONSTRAINT session_operations_origin_check
    CHECK (origin IN ('USER', 'BACKGROUND')),
  CONSTRAINT session_operations_status_check
    CHECK (status IN ('QUEUED', 'RUNNING', 'WAITING_FOR_AUTH', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  CONSTRAINT session_operations_attempt_check
    CHECK (attempt_no >= 0),
  CONSTRAINT session_operations_terminal_check
    CHECK ((status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) = (finished_at IS NOT NULL)),
  CONSTRAINT session_operations_target_account_fkey
    FOREIGN KEY (target_account_id, target_id)
    REFERENCES "__SCHEMA__".target_accounts (id, target_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS session_operations_idempotency_idx
  ON "__SCHEMA__".session_operations (target_id, target_account_id, idempotency_key);

CREATE INDEX IF NOT EXISTS session_operations_claim_idx
  ON "__SCHEMA__".session_operations (status, created_at)
  WHERE status = 'QUEUED';

CREATE INDEX IF NOT EXISTS session_operations_key_idx
  ON "__SCHEMA__".session_operations (target_id, target_account_id, status);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".session_profiles (
  target_id            UUID        NOT NULL,
  target_account_id    UUID        NOT NULL,
  revision             INT         NOT NULL,
  location_worker_id   TEXT,
  state                TEXT        NOT NULL,
  pending_cleanups     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT session_profiles_pkey PRIMARY KEY (target_id, target_account_id),
  CONSTRAINT session_profiles_revision_check CHECK (revision >= 1),
  CONSTRAINT session_profiles_state_check CHECK (state IN ('ABSENT', 'PRESENT')),
  CONSTRAINT session_profiles_target_account_fkey
    FOREIGN KEY (target_account_id, target_id)
    REFERENCES "__SCHEMA__".target_accounts (id, target_id) ON DELETE RESTRICT
);

ALTER TABLE "__SCHEMA__".workers
  ADD COLUMN IF NOT EXISTS protocol_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_leases_operation_id_fkey'
      AND conrelid = '"__SCHEMA__".session_leases'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_leases
      ADD CONSTRAINT session_leases_operation_id_fkey
      FOREIGN KEY (operation_id) REFERENCES "__SCHEMA__".session_operations (id) ON DELETE RESTRICT;
  END IF;
END $$;
