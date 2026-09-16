-- 0051：编写期模块映射请求、接受结果与保留清理。

CREATE TABLE "__SCHEMA__".module_resolution_requests (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  scenario_id UUID REFERENCES "__SCHEMA__".scenarios(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  expression TEXT NOT NULL,
  mode TEXT NOT NULL,
  term_revision TEXT,
  status TEXT NOT NULL,
  candidates JSONB NOT NULL,
  input_suggestions JSONB NOT NULL,
  unknowns JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_skipped TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending',
  accepted_module_version_id UUID REFERENCES "__SCHEMA__".action_module_versions(id) ON DELETE RESTRICT,
  accept_idempotency_key TEXT,
  accept_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT module_resolution_requests_mode_check CHECK (mode IN ('rules', 'rules_then_ai')),
  CONSTRAINT module_resolution_requests_status_check CHECK (status IN ('matched', 'suggested', 'ambiguous', 'no_match')),
  CONSTRAINT module_resolution_requests_outcome_check CHECK (outcome IN ('pending', 'accepted', 'rejected', 'abandoned'))
);
CREATE UNIQUE INDEX module_resolution_requests_actor_key_idx
  ON "__SCHEMA__".module_resolution_requests (actor_id, idempotency_key);
CREATE INDEX module_resolution_requests_target_created_idx
  ON "__SCHEMA__".module_resolution_requests (target_id, created_at);
CREATE INDEX module_resolution_requests_created_idx
  ON "__SCHEMA__".module_resolution_requests (created_at);
