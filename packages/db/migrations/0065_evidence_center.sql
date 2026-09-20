-- 0065：证据中心跨运行检索索引。查询先按证据时间／类型缩小，再联运行与对象。

CREATE INDEX IF NOT EXISTS evidences_created_id_idx
  ON "__SCHEMA__".evidences (created_at, id);

CREATE INDEX IF NOT EXISTS evidences_type_created_id_idx
  ON "__SCHEMA__".evidences (type, created_at, id);

CREATE INDEX IF NOT EXISTS runs_target_created_idx
  ON "__SCHEMA__".runs (target_id, created_at);

CREATE INDEX IF NOT EXISTS runs_scenario_created_idx
  ON "__SCHEMA__".runs (scenario_id, created_at);

CREATE INDEX IF NOT EXISTS stored_objects_status_retain_idx
  ON "__SCHEMA__".stored_objects (status, retain_until);
