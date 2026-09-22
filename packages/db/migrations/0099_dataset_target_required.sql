-- 0099：数据集必须归属目标系统。无目标行没有授权边界，收成非空前删除。
--
-- 全文幂等：重复执行不产生副作用。

DELETE FROM "__SCHEMA__".datasets WHERE target_id IS NULL;

ALTER TABLE "__SCHEMA__".datasets
  ALTER COLUMN target_id SET NOT NULL;
