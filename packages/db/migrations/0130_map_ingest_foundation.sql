-- 0130：统一地图采集的菜单授权、作业游标和页面知识读模型。
-- 旧作业已在 0128 清空；本迁移将数据库约束与 shared 的 map_ingest 契约对齐。

ALTER TABLE "__SCHEMA__".map_jobs DROP CONSTRAINT map_jobs_kind_check;
ALTER TABLE "__SCHEMA__".map_jobs
  ADD CONSTRAINT map_jobs_kind_check CHECK (job_kind IN ('map_ingest'));

ALTER TABLE "__SCHEMA__".target_access_policies
  ADD COLUMN read_only_requests_json JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "__SCHEMA__".map_job_policies
  ADD COLUMN ingest_max_depth INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN ingest_max_pages_per_entry INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN ingest_max_pages_per_job INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN ingest_max_job_seconds INTEGER NOT NULL DEFAULT 1800,
  ADD COLUMN ingest_nav_timeout_seconds INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN ingest_settle_timeout_seconds INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN ingest_page_budget_seconds INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN ingest_max_views_per_page INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN ingest_max_option_reads_per_page INTEGER NOT NULL DEFAULT 10;

CREATE TABLE "__SCHEMA__".map_menu_entries (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  entry_version INTEGER NOT NULL,
  entry_name TEXT NOT NULL,
  entry_url TEXT,
  menu_anchor JSONB,
  menu_label_key TEXT,
  arrival_name TEXT NOT NULL,
  arrival_target JSONB NOT NULL,
  enabled INTEGER NOT NULL,
  order_index INTEGER NOT NULL,
  active_guard TEXT,
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT map_menu_entries_url_or_anchor CHECK (entry_url IS NOT NULL OR menu_anchor IS NOT NULL)
);
CREATE UNIQUE INDEX map_menu_entries_active_url ON "__SCHEMA__".map_menu_entries (target_id, entry_url, active_guard);
CREATE UNIQUE INDEX map_menu_entries_active_label ON "__SCHEMA__".map_menu_entries (target_id, menu_label_key, active_guard);
CREATE INDEX map_menu_entries_order ON "__SCHEMA__".map_menu_entries (target_id, order_index);

CREATE TABLE "__SCHEMA__".map_menu_entry_commands (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  command_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_menu_entry_commands_key UNIQUE (target_id, command_key)
);

CREATE TABLE "__SCHEMA__".map_menu_entry_revisions (
  id UUID PRIMARY KEY,
  entry_id UUID NOT NULL REFERENCES "__SCHEMA__".map_menu_entries(id) ON DELETE RESTRICT,
  entry_version INTEGER NOT NULL,
  snapshot_json JSONB NOT NULL,
  updated_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_menu_entry_revisions_version UNIQUE (entry_id, entry_version)
);

ALTER TABLE "__SCHEMA__".map_jobs
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'full',
  ADD COLUMN ingest_cursor JSONB,
  ADD COLUMN ingest_summary JSONB,
  ADD COLUMN frozen_entries_json JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN frozen_access_revision INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT map_jobs_scope_check CHECK (scope IN ('full', 'entries', 'detect_top_menus'));

CREATE TABLE "__SCHEMA__".map_ingest_pages (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES "__SCHEMA__".map_jobs(id) ON DELETE RESTRICT,
  entry_id UUID NOT NULL REFERENCES "__SCHEMA__".map_menu_entries(id) ON DELETE RESTRICT,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  target_account_id UUID NOT NULL REFERENCES "__SCHEMA__".target_accounts(id) ON DELETE RESTRICT,
  page_key TEXT NOT NULL,
  view_state_key TEXT NOT NULL,
  menu_path_json JSONB NOT NULL,
  title TEXT NOT NULL,
  url_pattern TEXT NOT NULL,
  elements_json JSONB NOT NULL,
  completeness TEXT NOT NULL,
  reasons_json JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT map_ingest_pages_view UNIQUE (job_id, view_state_key),
  CONSTRAINT map_ingest_pages_completeness_check CHECK (completeness IN ('complete', 'partial'))
);
CREATE INDEX map_ingest_pages_target_page ON "__SCHEMA__".map_ingest_pages (target_id, page_key);
CREATE INDEX map_ingest_pages_entry ON "__SCHEMA__".map_ingest_pages (entry_id, observed_at);
