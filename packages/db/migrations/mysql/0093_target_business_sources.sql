-- 0093：目标系统业务数据源绑定、候选快照与查询投影表（MySQL 等价）。

CREATE TABLE target_business_sources (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  target_id VARCHAR(36) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  source_kind VARCHAR(64) NOT NULL DEFAULT 'dataset_snapshot',
  current_snapshot_id VARCHAR(36) NULL,
  binding_revision INT NOT NULL DEFAULT 1,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  owner_account_id VARCHAR(36) NOT NULL,
  approver_account_id VARCHAR(36) NULL,
  approved_at DATETIME(3) NULL,
  declared_source_as_of DATETIME(3) NULL,
  declared_by_account_id VARCHAR(36) NULL,
  declaration_basis TEXT NULL,
  valid_until DATETIME(3) NULL,
  completeness_basis TEXT NOT NULL,
  completeness_status VARCHAR(32) NOT NULL DEFAULT 'unknown',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_target_biz_sources_target FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE,
  CONSTRAINT fk_target_biz_sources_owner FOREIGN KEY (owner_account_id) REFERENCES console_accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_target_biz_sources_approver FOREIGN KEY (approver_account_id) REFERENCES console_accounts(id) ON DELETE SET NULL,
  CONSTRAINT fk_target_biz_sources_declared FOREIGN KEY (declared_by_account_id) REFERENCES console_accounts(id) ON DELETE SET NULL,
  UNIQUE KEY idx_target_business_sources_target_entity (target_id, entity_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_target_business_sources_target_status
  ON target_business_sources (target_id, status);

CREATE TABLE target_business_source_snapshots (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  source_binding_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  dataset_id VARCHAR(36) NOT NULL,
  build_status VARCHAR(32) NOT NULL DEFAULT 'building',
  rules_version INT NOT NULL DEFAULT 1,
  mapping_config JSON NOT NULL,
  validation_summary JSON NULL,
  source_observed_at DATETIME(3) NULL,
  owner_worker_id VARCHAR(128) NULL,
  lease_expires_at DATETIME(3) NULL,
  fencing_token INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_target_biz_snapshots_binding FOREIGN KEY (source_binding_id) REFERENCES target_business_sources(id) ON DELETE CASCADE,
  CONSTRAINT fk_target_biz_snapshots_target FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE,
  CONSTRAINT fk_target_biz_snapshots_dataset FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_target_business_snapshots_binding
  ON target_business_source_snapshots (source_binding_id, created_at);

CREATE INDEX idx_target_business_snapshots_status
  ON target_business_source_snapshots (build_status, lease_expires_at);

CREATE TABLE target_business_records (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  snapshot_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  record_key VARCHAR(128) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  record_status VARCHAR(64) NULL,
  original_dataset_id VARCHAR(36) NOT NULL,
  dataset_row_id VARCHAR(36) NOT NULL,
  dataset_row_index INT NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_target_biz_records_snapshot FOREIGN KEY (snapshot_id) REFERENCES target_business_source_snapshots(id) ON DELETE CASCADE,
  CONSTRAINT fk_target_biz_records_target FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE,
  CONSTRAINT fk_target_biz_records_dataset FOREIGN KEY (original_dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_target_business_records_query
  ON target_business_records (target_id, entity_type, display_name);

CREATE INDEX idx_target_business_records_key
  ON target_business_records (snapshot_id, record_key);

CREATE INDEX idx_target_business_records_snapshot_row
  ON target_business_records (snapshot_id, dataset_row_index);
