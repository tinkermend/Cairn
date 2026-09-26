-- 0115：支持安全进入路径软删除归档，保留历史在途与完成作业外键引用。

ALTER TABLE "__SCHEMA__".map_safe_entries ADD COLUMN archived_at TIMESTAMPTZ;
CREATE INDEX map_safe_entries_archived_idx ON "__SCHEMA__".map_safe_entries (target_id, archived_at);
