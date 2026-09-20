-- 0079：报告删除与幂等回执；允许同一修订在不同导出请求中重试。
ALTER TABLE "__SCHEMA__".reports
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN request_digest TEXT,
  ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE UNIQUE INDEX reports_idempotency_idx ON "__SCHEMA__".reports (created_by_console_account_id, idempotency_key);
ALTER TABLE "__SCHEMA__".report_revisions
  ADD COLUMN created_by_console_account_id UUID REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN request_digest TEXT;
CREATE UNIQUE INDEX report_revisions_idempotency_idx ON "__SCHEMA__".report_revisions (created_by_console_account_id, idempotency_key);
DROP INDEX "__SCHEMA__".export_jobs_revision_format_idx;
CREATE INDEX export_jobs_revision_format_idx ON "__SCHEMA__".export_jobs (report_revision_id, kind, request_digest);
