-- 0115 的 MySQL 等价增量：支持安全进入路径软删除归档，保留历史在途与完成作业外键引用。

ALTER TABLE map_safe_entries ADD COLUMN archived_at DATETIME(3) NULL;
CREATE INDEX map_safe_entries_archived_idx ON map_safe_entries (target_id, archived_at);
