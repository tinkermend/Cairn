-- 0069 的 MySQL 等价增量：step_runs 冻结步骤显示名。

ALTER TABLE step_runs
  ADD COLUMN name VARCHAR(128);

UPDATE step_runs AS sr
INNER JOIN runs AS r ON r.id = sr.run_id
INNER JOIN JSON_TABLE(
  r.snapshot,
  '$.steps[*]' COLUMNS (
    id VARCHAR(36) COLLATE utf8mb4_0900_bin PATH '$.id',
    step_name VARCHAR(128) PATH '$.name'
  )
) AS jt ON jt.id = sr.step_id
SET sr.name = jt.step_name
WHERE sr.name IS NULL;
