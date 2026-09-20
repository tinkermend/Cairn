-- 0069：step_runs 冻结步骤显示名。证据列表只读这列，不再装入 runs.snapshot。

ALTER TABLE "__SCHEMA__".step_runs
  ADD COLUMN name TEXT;

UPDATE "__SCHEMA__".step_runs AS sr
SET name = step.elem->>'name'
FROM "__SCHEMA__".runs AS r
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(r.snapshot->'steps') = 'array' THEN r.snapshot->'steps'
    ELSE '[]'::jsonb
  END
) AS step(elem)
WHERE sr.run_id = r.id
  AND step.elem->>'id' = sr.step_id::text
  AND sr.name IS NULL;
