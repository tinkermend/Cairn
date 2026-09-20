-- 0060：启用中计划部分唯一（enabled_guard），以及全局回收水位。

ALTER TABLE "__SCHEMA__".schedules
  ADD COLUMN enabled_guard TEXT;

UPDATE "__SCHEMA__".schedules
   SET enabled_guard = 'Y'
 WHERE enabled = 1;

ALTER TABLE "__SCHEMA__".schedules
  DROP CONSTRAINT IF EXISTS schedules_account_consumer;

DROP INDEX IF EXISTS "__SCHEMA__".schedules_account_consumer;

CREATE UNIQUE INDEX schedules_account_consumer
  ON "__SCHEMA__".schedules (target_account_id, consumer_key, enabled_guard);

CREATE TABLE "__SCHEMA__".runtime_watermarks (
  name TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL
);
