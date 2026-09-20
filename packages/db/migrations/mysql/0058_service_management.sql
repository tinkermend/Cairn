-- 0074 的 MySQL 等价增量：服务调用方治理、归档与服务 Key 展示元数据。

ALTER TABLE service_callers
  ADD COLUMN archived_at DATETIME(3) NULL;

ALTER TABLE service_credentials
  ADD COLUMN metadata_revision INT NOT NULL DEFAULT 1,
  ADD COLUMN notes TEXT NULL,
  ADD CONSTRAINT service_credentials_metadata_revision_check CHECK (metadata_revision > 0);

-- 凭据目录投影早于本迁移已存在；只回填备注，服务域名称继续作为事实源。
UPDATE service_credentials sc
JOIN credentials c ON c.id = sc.id AND c.type = 'service_key'
SET sc.notes = c.notes
WHERE sc.notes IS NULL AND c.notes IS NOT NULL;

CREATE INDEX service_callers_archived_status_created_idx
  ON service_callers (archived_at, status, created_at, id);
