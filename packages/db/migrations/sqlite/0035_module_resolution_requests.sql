-- 0051 的 SQLite 等价增量：编写期模块映射请求。
CREATE TABLE module_resolution_requests (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE RESTRICT,
  scenario_id TEXT REFERENCES scenarios(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL REFERENCES console_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  expression TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('rules', 'rules_then_ai')),
  term_revision TEXT,
  status TEXT NOT NULL CHECK (status IN ('matched', 'suggested', 'ambiguous', 'no_match')),
  candidates TEXT NOT NULL CHECK (json_valid(candidates)),
  input_suggestions TEXT NOT NULL CHECK (json_valid(input_suggestions)),
  unknowns TEXT NOT NULL CHECK (json_valid(unknowns)),
  ai_skipped TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'accepted', 'rejected', 'abandoned')),
  accepted_module_version_id TEXT REFERENCES action_module_versions(id) ON DELETE RESTRICT,
  accept_idempotency_key TEXT,
  accept_response TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX module_resolution_requests_actor_key_idx ON module_resolution_requests (actor_id, idempotency_key);
CREATE INDEX module_resolution_requests_target_created_idx ON module_resolution_requests (target_id, created_at);
CREATE INDEX module_resolution_requests_created_idx ON module_resolution_requests (created_at);
