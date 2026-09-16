-- 知识建议请求摘要：避免幂等重试重新生成，摘要不存凭据正文。
ALTER TABLE "__SCHEMA__".map_authoring_proposals ADD COLUMN request_digest TEXT;
CREATE UNIQUE INDEX map_authoring_proposals_accept_key_idx ON "__SCHEMA__".map_authoring_proposals (scenario_id, accept_key);
