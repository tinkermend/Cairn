-- 0077 的 MySQL 等价增量：证据槽位 artifact_key 与 Target 敏感选择器。

ALTER TABLE evidences
  ADD COLUMN artifact_key varchar(160) NULL;

-- MySQL cannot backfill a non-deterministic expression during ADD COLUMN.
-- Existing IDs give historical rows stable keys; new writes keep the UUID default.
UPDATE evidences SET artifact_key = CONCAT('legacy:', id) WHERE artifact_key IS NULL;

ALTER TABLE evidences
  MODIFY COLUMN artifact_key varchar(160) NOT NULL DEFAULT (CONCAT('legacy:', UUID()));

CREATE UNIQUE INDEX evidences_run_artifact_key_idx ON evidences(run_id, artifact_key);

ALTER TABLE targets
  ADD COLUMN sensitive_selectors json NULL;

UPDATE targets SET sensitive_selectors = JSON_ARRAY() WHERE sensitive_selectors IS NULL;

ALTER TABLE targets
  MODIFY sensitive_selectors json NOT NULL DEFAULT (JSON_ARRAY());
