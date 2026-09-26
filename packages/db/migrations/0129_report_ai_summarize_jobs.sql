-- 0129：报告 AI 总结与质量保障作业表（report_ai_jobs）

CREATE TABLE IF NOT EXISTS "__SCHEMA__".report_ai_jobs (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  report_id UUID NOT NULL REFERENCES "__SCHEMA__".reports(id) ON DELETE RESTRICT,
  base_revision_id UUID NOT NULL REFERENCES "__SCHEMA__".report_revisions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending',
  model TEXT,
  prompt_version TEXT,
  input_digest TEXT,
  interpretation JSONB,
  ai_revision_id UUID REFERENCES "__SCHEMA__".report_revisions(id) ON DELETE RESTRICT,
  token_usage JSONB,
  duration_ms INT,
  error TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  holder_worker_id TEXT,
  holder_instance_id UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS report_ai_jobs_idempotency_idx
  ON "__SCHEMA__".report_ai_jobs (report_id, base_revision_id);

CREATE INDEX IF NOT EXISTS report_ai_jobs_pending_idx
  ON "__SCHEMA__".report_ai_jobs (status, lease_until);
