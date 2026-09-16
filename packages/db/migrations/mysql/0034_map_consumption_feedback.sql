-- 0050 的 MySQL 等价增量：TODO 写明本增量做什么。
-- 0050 的 MySQL 等价增量：确认错配冻结 Target 的新只读消费资格。
CREATE TABLE map_consumption_eligibility_suspensions (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  decision_id VARCHAR(36) NOT NULL,
  reason VARCHAR(256) NOT NULL,
  suspended_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_consumption_eligibility_suspensions_pkey PRIMARY KEY (id),
  CONSTRAINT map_consumption_eligibility_suspensions_target_unique UNIQUE (target_id),
  CONSTRAINT map_consumption_eligibility_suspensions_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT map_consumption_eligibility_suspensions_decision_fk FOREIGN KEY (decision_id) REFERENCES map_selection_decisions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
