-- 0080 的 MySQL 等价增量：开放服务请求排障事实、来源网络围栏与可逆冻结。

ALTER TABLE service_callers
  ADD COLUMN ip_whitelist JSON NOT NULL DEFAULT (JSON_ARRAY());

ALTER TABLE service_credentials
  ADD COLUMN suspended_at DATETIME(3) NULL;

CREATE TABLE service_request_logs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  caller_id CHAR(36) NOT NULL,
  credential_id CHAR(36) NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  method VARCHAR(16) NOT NULL,
  path VARCHAR(255) NOT NULL,
  status_code INT NOT NULL,
  latency_ms INT NOT NULL,
  client_ip VARCHAR(64) NULL,
  error_code VARCHAR(128) NULL,
  error_message TEXT NULL,
  diagnostic JSON NULL,
  request_summary JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT service_request_logs_caller_fk
    FOREIGN KEY (caller_id) REFERENCES service_callers(id) ON DELETE RESTRICT,
  CONSTRAINT service_request_logs_credential_fk
    FOREIGN KEY (credential_id) REFERENCES service_credentials(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX service_request_logs_caller_created_idx
  ON service_request_logs (caller_id, created_at, id);
CREATE INDEX service_request_logs_caller_request_idx
  ON service_request_logs (caller_id, request_id, id);
CREATE INDEX service_request_logs_retention_idx
  ON service_request_logs (created_at, id);
