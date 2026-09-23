-- 0100：runs 表新增业务输出包字段 output (JSONB)。终态落盘不可变业务输出与巡检结果。

ALTER TABLE "__SCHEMA__".runs
  ADD COLUMN IF NOT EXISTS output JSONB;
