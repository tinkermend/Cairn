-- 0080：开放服务请求排障事实、来源网络围栏与可逆冻结。

ALTER TABLE "__SCHEMA__".service_callers
  ADD COLUMN ip_whitelist JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "__SCHEMA__".service_credentials
  ADD COLUMN suspended_at TIMESTAMPTZ(3);

CREATE TABLE "__SCHEMA__".service_request_logs (
  id UUID PRIMARY KEY,
  caller_id UUID NOT NULL REFERENCES "__SCHEMA__".service_callers(id) ON DELETE RESTRICT,
  credential_id UUID NOT NULL REFERENCES "__SCHEMA__".service_credentials(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  client_ip TEXT,
  error_code TEXT,
  error_message TEXT,
  diagnostic JSONB,
  request_summary JSONB,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX service_request_logs_caller_created_idx
  ON "__SCHEMA__".service_request_logs (caller_id, created_at, id);
CREATE INDEX service_request_logs_caller_request_idx
  ON "__SCHEMA__".service_request_logs (caller_id, request_id, id);
CREATE INDEX service_request_logs_retention_idx
  ON "__SCHEMA__".service_request_logs (created_at, id);
