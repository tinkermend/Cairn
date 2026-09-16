-- 0050 的 SQLite 等价增量：TODO 写明本增量做什么。
-- 0050 的 SQLite 等价增量：确认错配冻结 Target 的新只读消费资格。
CREATE TABLE map_consumption_eligibility_suspensions (
  id TEXT NOT NULL PRIMARY KEY,
  target_id TEXT NOT NULL UNIQUE REFERENCES targets(id) ON DELETE RESTRICT,
  decision_id TEXT NOT NULL REFERENCES map_selection_decisions(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  suspended_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
