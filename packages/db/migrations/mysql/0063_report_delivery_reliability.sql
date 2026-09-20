-- 0079 的 MySQL 等价增量：报告删除与幂等回执；支持重新导出。
ALTER TABLE reports
  ADD COLUMN idempotency_key VARCHAR(128),
  ADD COLUMN request_digest VARCHAR(64),
  ADD COLUMN deleted_at DATETIME(3);
CREATE UNIQUE INDEX reports_idempotency_idx ON reports (created_by_console_account_id, idempotency_key);
ALTER TABLE report_revisions
  ADD COLUMN created_by_console_account_id CHAR(36),
  ADD COLUMN idempotency_key VARCHAR(128),
  ADD COLUMN request_digest VARCHAR(64),
  ADD CONSTRAINT report_revisions_actor_fkey FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX report_revisions_idempotency_idx ON report_revisions (created_by_console_account_id, idempotency_key);
CREATE INDEX export_jobs_revision_lookup_idx ON export_jobs (report_revision_id, kind, request_digest(128));
DROP INDEX export_jobs_revision_format_idx ON export_jobs;
ALTER TABLE export_jobs RENAME INDEX export_jobs_revision_lookup_idx TO export_jobs_revision_format_idx;
