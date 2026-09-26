-- 0121：浏览器宿主池与登录态快照（browser_sessions.isolation, host_id; session_state_snapshots）

ALTER TABLE "__SCHEMA__".browser_sessions
  ADD COLUMN IF NOT EXISTS isolation TEXT,
  ADD COLUMN IF NOT EXISTS host_id TEXT;

CREATE TABLE IF NOT EXISTS "__SCHEMA__".session_state_snapshots (
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE CASCADE,
  target_account_id UUID NOT NULL REFERENCES "__SCHEMA__".target_accounts(id) ON DELETE CASCADE,
  account_slot INT NOT NULL DEFAULT 1,
  state JSONB,
  format_version INT NOT NULL DEFAULT 1,
  byte_size INT NOT NULL DEFAULT 0,
  cookie_count INT NOT NULL DEFAULT 0,
  origin_count INT NOT NULL DEFAULT 0,
  has_indexed_db BOOLEAN NOT NULL DEFAULT false,
  earliest_cookie_expiry TIMESTAMPTZ,
  session_id UUID,
  session_generation INT,
  session_fencing_token INT,
  identity TEXT,
  stale BOOLEAN NOT NULL DEFAULT false,
  content_digest TEXT,
  cleared_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, target_account_id, account_slot)
);

CREATE INDEX IF NOT EXISTS session_state_snapshots_account_idx
  ON "__SCHEMA__".session_state_snapshots (target_account_id);
