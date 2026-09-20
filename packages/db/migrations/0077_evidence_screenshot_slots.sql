-- 0077：证据槽位 artifact_key 与 Target 敏感选择器。多角色截图按 (run_id, artifact_key) 幂等，不依赖可空唯一索引。

ALTER TABLE "__SCHEMA__".evidences
  ADD COLUMN artifact_key text NOT NULL DEFAULT ('legacy:' || gen_random_uuid()::text);

CREATE UNIQUE INDEX evidences_run_artifact_key_idx ON "__SCHEMA__".evidences(run_id, artifact_key);

ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN sensitive_selectors jsonb NOT NULL DEFAULT '[]'::jsonb;
