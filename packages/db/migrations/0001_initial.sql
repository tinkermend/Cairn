-- 0001_initial：schema 与控制台身份模型
--
-- "__SCHEMA__" 是占位符，由迁移执行器在运行时替换为实际 schema 名，
-- 为日后多租户的 schema 隔离预留。
--
-- 全文幂等：重复执行不产生副作用。

CREATE SCHEMA IF NOT EXISTS "__SCHEMA__";

-- ─────────────────────────────────────────────────────────────
-- console_accounts —— 主体
--
-- 一个「人」在本平台的身份归属：角色、权限、审计归属都挂在这里。
-- 它刻意不含任何认证方式的信息，认证方式全部在 console_identities。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "__SCHEMA__".console_accounts (
  id            TEXT        PRIMARY KEY,
  display_name  TEXT        NOT NULL,
  email         TEXT,
  role          TEXT        NOT NULL DEFAULT 'operator',
  status        TEXT        NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'console_accounts_role_check'
      AND conrelid = '"__SCHEMA__".console_accounts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".console_accounts
      ADD CONSTRAINT console_accounts_role_check
      CHECK (role IN ('admin', 'operator', 'viewer'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'console_accounts_status_check'
      AND conrelid = '"__SCHEMA__".console_accounts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".console_accounts
      ADD CONSTRAINT console_accounts_status_check
      CHECK (status IN ('active', 'disabled'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS console_accounts_email_idx
  ON "__SCHEMA__".console_accounts (lower(email))
  WHERE email IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- console_identities —— 身份来源
--
-- 「这个人如何证明自己是自己」。本地密码只是 provider='local' 的一种，
-- 与日后接入的 OIDC / LDAP 平级。
--
-- 拆开的理由：接客户 SSO 时是往这里新增一行，account 表与所有引用
-- account_id 的地方都不用动。反过来若把 provider 与密码塞进用户表，
-- 后补这一层要改遍每一处引用。
--
-- 同一 account 可持有多个 identity（本地密码 + 企业 SSO 并存）。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "__SCHEMA__".console_identities (
  id            TEXT        PRIMARY KEY,
  account_id    TEXT        NOT NULL
                            REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE CASCADE,
  provider      TEXT        NOT NULL,
  -- 该 provider 下的唯一标识：local 为登录名，OIDC 为 sub，LDAP 为 DN
  subject       TEXT        NOT NULL,
  -- 仅 local 使用，存密码哈希；外部 provider 恒为 NULL
  secret        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'console_identities_secret_check'
      AND conrelid = '"__SCHEMA__".console_identities'::regclass
  ) THEN
    -- 由数据库保证：本地身份必须有密码哈希，外部身份必须没有。
    -- 不能只靠应用层——凭据字段写错的代价太高。
    ALTER TABLE "__SCHEMA__".console_identities
      ADD CONSTRAINT console_identities_secret_check
      CHECK (
        (provider = 'local' AND secret IS NOT NULL) OR
        (provider <> 'local' AND secret IS NULL)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS console_identities_provider_subject_idx
  ON "__SCHEMA__".console_identities (provider, subject);

CREATE INDEX IF NOT EXISTS console_identities_account_idx
  ON "__SCHEMA__".console_identities (account_id);
