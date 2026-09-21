-- 0090 的 MySQL 等价增量：目标系统解析优先顺序与可选更严上限。

ALTER TABLE targets
  ADD COLUMN resolution_policy JSON,
  ADD CONSTRAINT targets_resolution_policy_object
    CHECK ((resolution_policy IS NULL) OR (LOWER(JSON_TYPE(resolution_policy)) = 'object'));
