-- 0004_targets：目标系统、目标账号、本地凭据密文
--
-- Target 是外部业务系统身份，不等于 URL。TargetAccount 与控制台账号分离。
-- 密文在 secrets；账号只存 secret_provider + secret_id。
-- secret_id 外键必须 RESTRICT：SET NULL 会单独清空 secret_id、留下
-- secret_provider，撞上「同有或同无」CHECK。
--
-- 全文幂等：重复执行不产生副作用。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".targets (
  id            UUID        PRIMARY KEY,
  code          TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  entry_url     TEXT        NOT NULL,
  login_url     TEXT,
  auth_method   TEXT        NOT NULL DEFAULT 'password',
  captcha_mode  TEXT        NOT NULL DEFAULT 'none',
  status        TEXT        NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'targets_status_check'
      AND conrelid = '"__SCHEMA__".targets'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".targets
      ADD CONSTRAINT targets_status_check
      CHECK (status IN ('active', 'disabled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'targets_auth_method_check'
      AND conrelid = '"__SCHEMA__".targets'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".targets
      ADD CONSTRAINT targets_auth_method_check
      CHECK (auth_method IN ('password', 'manual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'targets_captcha_mode_check'
      AND conrelid = '"__SCHEMA__".targets'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".targets
      ADD CONSTRAINT targets_captcha_mode_check
      CHECK (captcha_mode IN ('none', 'image', 'slider', 'sms', 'other'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS targets_code_idx
  ON "__SCHEMA__".targets (code);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".secrets (
  id            UUID        PRIMARY KEY,
  provider      TEXT        NOT NULL,
  ciphertext    BYTEA       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".target_accounts (
  id                UUID        PRIMARY KEY,
  target_id         UUID        NOT NULL
                                REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  display_name      TEXT        NOT NULL,
  username          TEXT        NOT NULL,
  secret_provider   TEXT,
  secret_id         UUID        REFERENCES "__SCHEMA__".secrets (id) ON DELETE RESTRICT,
  status            TEXT        NOT NULL DEFAULT 'active',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'target_accounts_status_check'
      AND conrelid = '"__SCHEMA__".target_accounts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".target_accounts
      ADD CONSTRAINT target_accounts_status_check
      CHECK (status IN ('active', 'disabled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'target_accounts_secret_ref_pair'
      AND conrelid = '"__SCHEMA__".target_accounts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".target_accounts
      ADD CONSTRAINT target_accounts_secret_ref_pair
      CHECK (
        (secret_id IS NULL AND secret_provider IS NULL)
        OR (secret_id IS NOT NULL AND secret_provider IS NOT NULL)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS target_accounts_target_username_idx
  ON "__SCHEMA__".target_accounts (target_id, username);

CREATE INDEX IF NOT EXISTS target_accounts_target_id_idx
  ON "__SCHEMA__".target_accounts (target_id);
