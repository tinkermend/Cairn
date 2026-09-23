-- 0100 的 MySQL 等价增量：runs 表新增业务输出包字段 output (JSON)。

ALTER TABLE runs
  ADD COLUMN output JSON;
