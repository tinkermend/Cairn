-- 0113：平台助手排队上下文持久化（request_payload）。

ALTER TABLE "__SCHEMA__".assistant_turns
  ADD COLUMN request_payload JSONB;
