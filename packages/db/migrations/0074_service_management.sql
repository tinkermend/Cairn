-- 0074：服务调用方治理、归档与服务 Key 展示元数据。

ALTER TABLE "__SCHEMA__".service_callers
  ADD COLUMN archived_at TIMESTAMPTZ(3),
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at,
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at;

ALTER TABLE "__SCHEMA__".service_credentials
  ADD COLUMN metadata_revision INT NOT NULL DEFAULT 1,
  ADD COLUMN notes TEXT;

ALTER TABLE "__SCHEMA__".service_credentials
  ADD CONSTRAINT service_credentials_metadata_revision_check CHECK (metadata_revision > 0);

-- 凭据目录投影早于本迁移已存在；只回填备注，服务域名称继续作为事实源。
UPDATE "__SCHEMA__".service_credentials sc
SET notes = c.notes
FROM "__SCHEMA__".credentials c
WHERE c.id = sc.id
  AND c.type = 'service_key'
  AND sc.notes IS NULL
  AND c.notes IS NOT NULL;

CREATE INDEX service_callers_archived_status_created_idx
  ON "__SCHEMA__".service_callers (archived_at, status, created_at, id);
