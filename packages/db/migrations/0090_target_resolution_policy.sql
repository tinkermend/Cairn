-- 0090：目标系统解析优先顺序与可选更严上限。

ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN resolution_policy JSONB,
  ADD CONSTRAINT targets_resolution_policy_object
    CHECK (resolution_policy IS NULL OR jsonb_typeof(resolution_policy) = 'object');
