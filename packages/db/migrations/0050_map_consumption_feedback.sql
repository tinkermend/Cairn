-- 0050：TODO 写明本增量做什么。
-- 0050：确认错配冻结 Target 的新只读消费资格；既有资格与反证事实均保留。
CREATE TABLE "__SCHEMA__".map_consumption_eligibility_suspensions (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  decision_id UUID NOT NULL REFERENCES "__SCHEMA__".map_selection_decisions(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  suspended_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX map_consumption_eligibility_suspensions_target
  ON "__SCHEMA__".map_consumption_eligibility_suspensions (target_id);
