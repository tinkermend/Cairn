-- 0109：目标系统业务数据源绑定、候选快照与查询投影表。

CREATE TABLE "__SCHEMA__".target_business_sources (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'dataset_snapshot',
  current_snapshot_id UUID,
  binding_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  owner_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE CASCADE,
  approver_account_id UUID REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  declared_source_as_of TIMESTAMPTZ,
  declared_by_account_id UUID REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE SET NULL,
  declaration_basis TEXT,
  valid_until TIMESTAMPTZ,
  completeness_basis TEXT NOT NULL DEFAULT '快照全量扫描校验',
  completeness_status TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_target_business_sources_target_entity
  ON "__SCHEMA__".target_business_sources (target_id, entity_type);

CREATE INDEX idx_target_business_sources_target_status
  ON "__SCHEMA__".target_business_sources (target_id, status);

CREATE TABLE "__SCHEMA__".target_business_source_snapshots (
  id UUID PRIMARY KEY,
  source_binding_id UUID NOT NULL REFERENCES "__SCHEMA__".target_business_sources(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  dataset_id UUID NOT NULL REFERENCES "__SCHEMA__".datasets(id) ON DELETE CASCADE,
  build_status TEXT NOT NULL DEFAULT 'building',
  rules_version INTEGER NOT NULL DEFAULT 1,
  mapping_config JSONB NOT NULL,
  validation_summary JSONB,
  source_observed_at TIMESTAMPTZ,
  owner_worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_target_business_snapshots_binding
  ON "__SCHEMA__".target_business_source_snapshots (source_binding_id, created_at);

CREATE INDEX idx_target_business_snapshots_status
  ON "__SCHEMA__".target_business_source_snapshots (build_status, lease_expires_at);

CREATE TABLE "__SCHEMA__".target_business_records (
  id UUID PRIMARY KEY,
  snapshot_id UUID NOT NULL REFERENCES "__SCHEMA__".target_business_source_snapshots(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  record_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  record_status TEXT,
  original_dataset_id UUID NOT NULL REFERENCES "__SCHEMA__".datasets(id) ON DELETE CASCADE,
  dataset_row_id UUID NOT NULL,
  dataset_row_index INTEGER NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_target_business_records_query
  ON "__SCHEMA__".target_business_records (target_id, entity_type, display_name);

CREATE INDEX idx_target_business_records_key
  ON "__SCHEMA__".target_business_records (snapshot_id, record_key);

CREATE INDEX idx_target_business_records_snapshot_row
  ON "__SCHEMA__".target_business_records (snapshot_id, dataset_row_index);
