-- 0097 的 MySQL 等价增量：数据集资产管理与批量自动化引擎账本。

CREATE TABLE IF NOT EXISTS datasets (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  source_type VARCHAR(16) NOT NULL,
  source_filename VARCHAR(255) NOT NULL,
  selected_sheet VARCHAR(255) NULL,
  row_count INT NOT NULL DEFAULT 0,
  columns_meta JSON NOT NULL,
  created_by_account_id VARCHAR(36) NULL,
  deleted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT datasets_pkey PRIMARY KEY (id),
  CONSTRAINT datasets_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE,
  CONSTRAINT datasets_account_fk FOREIGN KEY (created_by_account_id) REFERENCES console_accounts(id) ON DELETE SET NULL,
  CONSTRAINT datasets_source_type_check CHECK (source_type IN ('excel', 'csv', 'table'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_datasets_target ON datasets (target_id);
CREATE INDEX idx_datasets_created_at ON datasets (created_at);
CREATE INDEX idx_datasets_deleted_at ON datasets (deleted_at);


CREATE TABLE IF NOT EXISTS dataset_rows (
  id VARCHAR(36) NOT NULL,
  dataset_id VARCHAR(36) NOT NULL,
  row_index INT NOT NULL,
  row_data JSON NOT NULL,
  valid_status VARCHAR(16) NOT NULL DEFAULT 'valid',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT dataset_rows_pkey PRIMARY KEY (id),
  CONSTRAINT dataset_rows_dataset_fk FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,
  CONSTRAINT dataset_rows_valid_status_check CHECK (valid_status IN ('valid', 'warning', 'error'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_dataset_rows_dataset_idx ON dataset_rows (dataset_id, row_index);
CREATE INDEX idx_dataset_rows_dataset_status ON dataset_rows (dataset_id, valid_status);


CREATE TABLE IF NOT EXISTS batches (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  scenario_id VARCHAR(36) NOT NULL,
  scenario_version_id VARCHAR(36) NOT NULL,
  dataset_id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
  failure_policy VARCHAR(24) NOT NULL DEFAULT 'stop_on_threshold',
  failure_threshold INT NOT NULL DEFAULT 5,
  data_bindings JSON NOT NULL,
  pacing_config JSON NOT NULL,
  total_items INT NOT NULL DEFAULT 0,
  success_items INT NOT NULL DEFAULT 0,
  failed_items INT NOT NULL DEFAULT 0,
  review_items INT NOT NULL DEFAULT 0,
  paused_reason TEXT NULL,
  created_by_account_id VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT batches_pkey PRIMARY KEY (id),
  CONSTRAINT batches_scenario_fk FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE,
  CONSTRAINT batches_scenario_version_fk FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE CASCADE,
  CONSTRAINT batches_dataset_fk FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,
  CONSTRAINT batches_target_account_fk FOREIGN KEY (target_account_id) REFERENCES target_accounts(id) ON DELETE SET NULL,
  CONSTRAINT batches_account_fk FOREIGN KEY (created_by_account_id) REFERENCES console_accounts(id) ON DELETE SET NULL,
  CONSTRAINT batches_status_check CHECK (status IN ('QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED')),
  CONSTRAINT batches_failure_policy_check CHECK (failure_policy IN ('continue', 'stop_on_first', 'stop_on_threshold'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_batches_scenario ON batches (scenario_id);
CREATE INDEX idx_batches_status ON batches (status);
CREATE INDEX idx_batches_created_at ON batches (created_at);


CREATE TABLE IF NOT EXISTS batch_items (
  id VARCHAR(36) NOT NULL,
  batch_id VARCHAR(36) NOT NULL,
  dataset_row_index INT NOT NULL,
  run_id VARCHAR(36) NULL,
  item_status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  outcome_verdict VARCHAR(64) NULL,
  failure_domain VARCHAR(16) NULL,
  error_message TEXT NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  CONSTRAINT batch_items_pkey PRIMARY KEY (id),
  CONSTRAINT batch_items_batch_fk FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
  CONSTRAINT batch_items_run_fk FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL,
  CONSTRAINT batch_items_item_status_check CHECK (item_status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW')),
  CONSTRAINT batch_items_failure_domain_check CHECK (failure_domain IS NULL OR failure_domain IN ('ITEM', 'TARGET', 'SESSION'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_batch_items_batch_status ON batch_items (batch_id, item_status);
CREATE INDEX idx_batch_items_run ON batch_items (run_id);
CREATE INDEX idx_batch_items_batch_row ON batch_items (batch_id, dataset_row_index);


ALTER TABLE runs DROP CHECK runs_execution_origin_check;
ALTER TABLE runs ADD CONSTRAINT runs_execution_origin_check
  CHECK (execution_origin IN ('standalone', 'suite_member', 'batch_item'));

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
CROSS JOIN (
  SELECT 'dataset:read' AS permission
  UNION ALL SELECT 'dataset:write'
  UNION ALL SELECT 'dataset:delete'
  UNION ALL SELECT 'batch:read'
  UNION ALL SELECT 'batch:write'
  UNION ALL SELECT 'batch:execute'
) p
WHERE r.key = 'admin';
