-- 知识建议请求摘要：避免幂等重试重新生成，摘要不存凭据正文。
ALTER TABLE map_authoring_proposals ADD COLUMN request_digest TEXT;
CREATE UNIQUE INDEX map_authoring_proposals_accept_key_idx ON map_authoring_proposals (scenario_id, accept_key);
