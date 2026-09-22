-- 0097_dataset_and_batches：数据集资产管理与批量自动化引擎账本
--
-- 全文幂等：重复执行不产生副作用。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".datasets (
  id                    UUID        PRIMARY KEY,
  name                  TEXT        NOT NULL,
  target_id             UUID        NOT NULL
                                    REFERENCES "__SCHEMA__".targets (id) ON DELETE CASCADE,
  source_type           TEXT        NOT NULL,
  source_filename       TEXT        NOT NULL,
  selected_sheet        TEXT,
  row_count             INT         NOT NULL DEFAULT 0,
  columns_meta          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_by_account_id UUID        REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE SET NULL,
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'datasets_source_type_check'
      AND conrelid = '"__SCHEMA__".datasets'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".datasets
      ADD CONSTRAINT datasets_source_type_check
      CHECK (source_type IN ('excel', 'csv', 'table'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_datasets_target
  ON "__SCHEMA__".datasets (target_id);

CREATE INDEX IF NOT EXISTS idx_datasets_created_at
  ON "__SCHEMA__".datasets (created_at);

CREATE INDEX IF NOT EXISTS idx_datasets_deleted_at
  ON "__SCHEMA__".datasets (deleted_at);


CREATE TABLE IF NOT EXISTS "__SCHEMA__".dataset_rows (
  id                    UUID        PRIMARY KEY,
  dataset_id            UUID        NOT NULL
                                    REFERENCES "__SCHEMA__".datasets (id) ON DELETE CASCADE,
  row_index             INT         NOT NULL,
  row_data              JSONB       NOT NULL,
  valid_status          TEXT        NOT NULL DEFAULT 'valid',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dataset_rows_valid_status_check'
      AND conrelid = '"__SCHEMA__".dataset_rows'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".dataset_rows
      ADD CONSTRAINT dataset_rows_valid_status_check
      CHECK (valid_status IN ('valid', 'warning', 'error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_dataset_rows_dataset_idx
  ON "__SCHEMA__".dataset_rows (dataset_id, row_index);

CREATE INDEX IF NOT EXISTS idx_dataset_rows_dataset_status
  ON "__SCHEMA__".dataset_rows (dataset_id, valid_status);


CREATE TABLE IF NOT EXISTS "__SCHEMA__".batches (
  id                    UUID        PRIMARY KEY,
  name                  TEXT        NOT NULL,
  scenario_id           UUID        NOT NULL
                                    REFERENCES "__SCHEMA__".scenarios (id) ON DELETE CASCADE,
  scenario_version_id   UUID        NOT NULL
                                    REFERENCES "__SCHEMA__".scenario_versions (id) ON DELETE CASCADE,
  dataset_id            UUID        NOT NULL
                                    REFERENCES "__SCHEMA__".datasets (id) ON DELETE CASCADE,
  target_account_id     UUID        REFERENCES "__SCHEMA__".target_accounts (id) ON DELETE SET NULL,
  status                TEXT        NOT NULL DEFAULT 'QUEUED',
  failure_policy        TEXT        NOT NULL DEFAULT 'stop_on_threshold',
  failure_threshold     INT         NOT NULL DEFAULT 5,
  data_bindings         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  pacing_config         JSONB       NOT NULL DEFAULT '{"minDelayMs":1500,"maxDelayMs":3500}'::jsonb,
  total_items           INT         NOT NULL DEFAULT 0,
  success_items         INT         NOT NULL DEFAULT 0,
  failed_items          INT         NOT NULL DEFAULT 0,
  review_items          INT         NOT NULL DEFAULT 0,
  paused_reason         TEXT,
  created_by_account_id UUID        REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'batches_status_check'
      AND conrelid = '"__SCHEMA__".batches'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".batches
      ADD CONSTRAINT batches_status_check
      CHECK (status IN ('QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'batches_failure_policy_check'
      AND conrelid = '"__SCHEMA__".batches'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".batches
      ADD CONSTRAINT batches_failure_policy_check
      CHECK (failure_policy IN ('continue', 'stop_on_first', 'stop_on_threshold'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_batches_scenario
  ON "__SCHEMA__".batches (scenario_id);

CREATE INDEX IF NOT EXISTS idx_batches_status
  ON "__SCHEMA__".batches (status);

CREATE INDEX IF NOT EXISTS idx_batches_created_at
  ON "__SCHEMA__".batches (created_at);


CREATE TABLE IF NOT EXISTS "__SCHEMA__".batch_items (
  id                    UUID        PRIMARY KEY,
  batch_id              UUID        NOT NULL
                                    REFERENCES "__SCHEMA__".batches (id) ON DELETE CASCADE,
  dataset_row_index     INT         NOT NULL,
  run_id                UUID        REFERENCES "__SCHEMA__".runs (id) ON DELETE SET NULL,
  item_status           TEXT        NOT NULL DEFAULT 'PENDING',
  outcome_verdict       TEXT,
  failure_domain        TEXT,
  error_message         TEXT,
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'batch_items_item_status_check'
      AND conrelid = '"__SCHEMA__".batch_items'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".batch_items
      ADD CONSTRAINT batch_items_item_status_check
      CHECK (item_status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'batch_items_failure_domain_check'
      AND conrelid = '"__SCHEMA__".batch_items'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".batch_items
      ADD CONSTRAINT batch_items_failure_domain_check
      CHECK (failure_domain IS NULL OR failure_domain IN ('ITEM', 'TARGET', 'SESSION'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_batch_items_batch_status
  ON "__SCHEMA__".batch_items (batch_id, item_status);

CREATE INDEX IF NOT EXISTS idx_batch_items_run
  ON "__SCHEMA__".batch_items (run_id);

CREATE INDEX IF NOT EXISTS idx_batch_items_batch_row
  ON "__SCHEMA__".batch_items (batch_id, dataset_row_index);


ALTER TABLE "__SCHEMA__".runs DROP CONSTRAINT IF EXISTS runs_execution_origin_check;
ALTER TABLE "__SCHEMA__".runs ADD CONSTRAINT runs_execution_origin_check
  CHECK (execution_origin IN ('standalone', 'suite_member', 'batch_item'));

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
CROSS JOIN (VALUES
  ('dataset:read'),
  ('dataset:write'),
  ('dataset:delete'),
  ('batch:read'),
  ('batch:write'),
  ('batch:execute')
) p(permission)
WHERE r.key = 'admin'
ON CONFLICT DO NOTHING;
