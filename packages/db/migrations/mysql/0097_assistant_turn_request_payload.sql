-- 0097：平台助手排队上下文持久化（request_payload）（MySQL 等价）。

ALTER TABLE assistant_turns
  ADD COLUMN request_payload JSON NULL;
