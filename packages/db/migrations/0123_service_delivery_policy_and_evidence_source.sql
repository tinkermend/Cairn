-- 0123：服务调用方交付策略与证据放行来源（service_callers.delivery_policy; evidences.external_access_source）

ALTER TABLE "__SCHEMA__".service_callers
  ADD COLUMN IF NOT EXISTS delivery_policy JSONB;

UPDATE "__SCHEMA__".service_callers
  SET delivery_policy = '{"runOutput":false,"finalScreenshot":false,"failureScreenshot":false}'
  WHERE delivery_policy IS NULL;

ALTER TABLE "__SCHEMA__".evidences
  ADD COLUMN IF NOT EXISTS external_access_source TEXT;
