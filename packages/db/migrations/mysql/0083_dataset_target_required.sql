-- 0099 的 MySQL 等价增量：数据集必须归属目标系统。无目标行没有授权边界，收成非空前删除。

DELETE FROM datasets WHERE target_id IS NULL;

ALTER TABLE datasets
  MODIFY COLUMN target_id VARCHAR(36) NOT NULL;
