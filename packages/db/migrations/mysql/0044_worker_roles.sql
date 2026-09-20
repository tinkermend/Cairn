-- 0060 的 MySQL 等价增量：启用中计划部分唯一（enabled_guard），以及全局回收水位。

ALTER TABLE schedules
  ADD COLUMN enabled_guard VARCHAR(1) NULL;

UPDATE schedules
   SET enabled_guard = 'Y'
 WHERE enabled = 1;

ALTER TABLE schedules
  ADD UNIQUE KEY schedules_account_consumer_guard (target_account_id, consumer_key, enabled_guard);

ALTER TABLE schedules
  DROP INDEX schedules_account_consumer;

ALTER TABLE schedules
  RENAME INDEX schedules_account_consumer_guard TO schedules_account_consumer;

CREATE TABLE runtime_watermarks (
  name VARCHAR(64) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  CONSTRAINT runtime_watermarks_pkey PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
