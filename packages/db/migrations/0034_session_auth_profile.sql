-- 0034：版本化认证规则、账号期望身份、核验摘要与账号级登录预算。追加迁移，不改 session-occupancy@2。

ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN IF NOT EXISTS current_auth_profile_revision INTEGER;

ALTER TABLE "__SCHEMA__".target_accounts
  ADD COLUMN IF NOT EXISTS expected_identity TEXT,
  ADD COLUMN IF NOT EXISTS config_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "__SCHEMA__".target_accounts
  ADD CONSTRAINT target_accounts_config_revision_check CHECK (config_revision >= 1);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".target_auth_profiles (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  definition JSONB NOT NULL,
  digest TEXT NOT NULL,
  validation JSONB,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT target_auth_profiles_revision_check CHECK (revision >= 1),
  CONSTRAINT target_auth_profiles_target_revision_key UNIQUE (target_id, revision)
);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".target_account_auth_budget (
  id UUID PRIMARY KEY,
  target_account_id UUID NOT NULL UNIQUE REFERENCES "__SCHEMA__".target_accounts(id) ON DELETE RESTRICT,
  window_started_at TIMESTAMPTZ NOT NULL,
  auto_login_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  next_allowed_at TIMESTAMPTZ,
  last_config_revision INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT target_account_auth_budget_count_check CHECK (auto_login_count >= 0),
  CONSTRAINT target_account_auth_budget_fail_check CHECK (consecutive_failures >= 0)
);

ALTER TABLE "__SCHEMA__".browser_sessions
  ADD COLUMN IF NOT EXISTS last_auth_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_auth_success_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_auth_generation INTEGER,
  ADD COLUMN IF NOT EXISTS last_expected_identity TEXT,
  ADD COLUMN IF NOT EXISTS auth_valid_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auth_expiry_source TEXT,
  ADD COLUMN IF NOT EXISTS last_auth_error TEXT,
  ADD COLUMN IF NOT EXISTS auth_profile_revision INTEGER,
  ADD COLUMN IF NOT EXISTS identity_state TEXT,
  ADD COLUMN IF NOT EXISTS identity_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS observed_tier TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_identity_state_check'
      AND conrelid = '__SCHEMA__.browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_identity_state_check
      CHECK (identity_state IS NULL OR identity_state IN ('UNVERIFIED', 'MATCH', 'MISMATCH'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_observed_tier_check'
      AND conrelid = '__SCHEMA__.browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_observed_tier_check
      CHECK (observed_tier IS NULL OR observed_tier IN ('IDENTITY_VERIFIED', 'LOGIN_VERIFIED', 'LEGACY'));
  END IF;
END $$;
