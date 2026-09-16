-- 0034 的 MySQL 等价增量：认证规则、期望身份、核验摘要与登录预算。

ALTER TABLE targets
  ADD COLUMN current_auth_profile_revision INT NULL;

ALTER TABLE target_accounts
  ADD COLUMN expected_identity VARCHAR(256) NULL,
  ADD COLUMN config_revision INT NOT NULL DEFAULT 1;

ALTER TABLE target_accounts
  ADD CONSTRAINT target_accounts_config_revision_check CHECK (config_revision >= 1);

CREATE TABLE target_auth_profiles (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  revision INT NOT NULL,
  definition JSON NOT NULL,
  digest VARCHAR(128) NOT NULL,
  validation JSON NULL,
  created_by VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT target_auth_profiles_pkey PRIMARY KEY (id),
  CONSTRAINT target_auth_profiles_revision_check CHECK (revision >= 1),
  CONSTRAINT target_auth_profiles_target_revision_key UNIQUE (target_id, revision),
  CONSTRAINT target_auth_profiles_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE target_account_auth_budget (
  id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36) NOT NULL,
  window_started_at DATETIME(3) NOT NULL,
  auto_login_count INT NOT NULL DEFAULT 0,
  consecutive_failures INT NOT NULL DEFAULT 0,
  paused_reason VARCHAR(128) NULL,
  next_allowed_at DATETIME(3) NULL,
  last_config_revision INT NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT target_account_auth_budget_pkey PRIMARY KEY (id),
  CONSTRAINT target_account_auth_budget_account_key UNIQUE (target_account_id),
  CONSTRAINT target_account_auth_budget_count_check CHECK (auto_login_count >= 0),
  CONSTRAINT target_account_auth_budget_fail_check CHECK (consecutive_failures >= 0),
  CONSTRAINT target_account_auth_budget_account_fk FOREIGN KEY (target_account_id) REFERENCES target_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

ALTER TABLE browser_sessions
  ADD COLUMN last_auth_checked_at DATETIME(3) NULL,
  ADD COLUMN last_auth_success_at DATETIME(3) NULL,
  ADD COLUMN last_auth_generation INT NULL,
  ADD COLUMN last_expected_identity VARCHAR(256) NULL,
  ADD COLUMN auth_valid_until DATETIME(3) NULL,
  ADD COLUMN auth_expiry_source VARCHAR(64) NULL,
  ADD COLUMN last_auth_error VARCHAR(128) NULL,
  ADD COLUMN auth_profile_revision INT NULL,
  ADD COLUMN identity_state VARCHAR(16) NULL,
  ADD COLUMN identity_verified_at DATETIME(3) NULL,
  ADD COLUMN observed_tier VARCHAR(32) NULL,
  ADD CONSTRAINT browser_sessions_identity_state_check
    CHECK (identity_state IS NULL OR identity_state IN ('UNVERIFIED', 'MATCH', 'MISMATCH')),
  ADD CONSTRAINT browser_sessions_observed_tier_check
    CHECK (observed_tier IS NULL OR observed_tier IN ('IDENTITY_VERIFIED', 'LOGIN_VERIFIED', 'LEGACY'));
