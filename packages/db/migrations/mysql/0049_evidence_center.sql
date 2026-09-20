-- 0065 的 MySQL 等价增量：证据中心跨运行检索索引。

CREATE INDEX evidences_created_id_idx ON evidences (created_at, id);
-- evidences.type 在 MySQL 里是 LONGTEXT，索引必须带前缀长度；取值最长 5 个字符，32 足够。
CREATE INDEX evidences_type_created_id_idx ON evidences (type(32), created_at, id);
CREATE INDEX runs_target_created_idx ON runs (target_id, created_at);
CREATE INDEX runs_scenario_created_idx ON runs (scenario_id, created_at);
CREATE INDEX stored_objects_status_retain_idx ON stored_objects (status, retain_until);
