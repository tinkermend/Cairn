-- 0034 的 SQLite 等价增量：认证规则、期望身份、核验摘要与登录预算。

ALTER TABLE targets ADD COLUMN current_auth_profile_revision INTEGER;
ALTER TABLE target_accounts ADD COLUMN expected_identity TEXT;
ALTER TABLE target_accounts ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE target_auth_profiles (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  digest TEXT NOT NULL,
  validation TEXT CHECK (validation IS NULL OR json_valid(validation)),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT target_auth_profiles_pkey PRIMARY KEY (id),
  CONSTRAINT target_auth_profiles_target_revision_key UNIQUE (target_id, revision),
  CONSTRAINT target_auth_profiles_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE target_account_auth_budget (
  id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  auto_login_count INTEGER NOT NULL DEFAULT 0 CHECK (auto_login_count >= 0),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  paused_reason TEXT,
  next_allowed_at TEXT,
  last_config_revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT target_account_auth_budget_pkey PRIMARY KEY (id),
  CONSTRAINT target_account_auth_budget_account_key UNIQUE (target_account_id),
  CONSTRAINT target_account_auth_budget_account_fk FOREIGN KEY (target_account_id) REFERENCES target_accounts(id) ON DELETE RESTRICT
);

ALTER TABLE browser_sessions ADD COLUMN last_auth_checked_at TEXT;
ALTER TABLE browser_sessions ADD COLUMN last_auth_success_at TEXT;
ALTER TABLE browser_sessions ADD COLUMN last_auth_generation INTEGER;
ALTER TABLE browser_sessions ADD COLUMN last_expected_identity TEXT;
ALTER TABLE browser_sessions ADD COLUMN auth_valid_until TEXT;
ALTER TABLE browser_sessions ADD COLUMN auth_expiry_source TEXT;
ALTER TABLE browser_sessions ADD COLUMN last_auth_error TEXT;
ALTER TABLE browser_sessions ADD COLUMN auth_profile_revision INTEGER;
ALTER TABLE browser_sessions ADD COLUMN identity_state TEXT;
ALTER TABLE browser_sessions ADD COLUMN identity_verified_at TEXT;
ALTER TABLE browser_sessions ADD COLUMN observed_tier TEXT;
