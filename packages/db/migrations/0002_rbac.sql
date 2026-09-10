-- 0002_rbac：角色 / 权限 / 账号-角色绑定
--
-- 把 console_accounts.role 这一列升级为标准 RBAC：
--   权限目录由应用代码拥有（不建 permissions 表，避免自造权限码）
--   角色是权限的命名集合（系统角色 + 自定义角色）
--   账号与角色多对多
--
-- 系统角色的 id 也是 UUID，不用 'admin' 这类可读值——那会把 id 列
-- 钉死在 TEXT 上。稳定标识由 key 承担，seed 与查询一律按 key。
--
-- 全文幂等：重复执行不产生副作用。

-- ─────────────────────────────────────────────────────────────
-- console_roles
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "__SCHEMA__".console_roles (
  id            UUID        PRIMARY KEY,
  key           TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  description   TEXT,
  kind          TEXT        NOT NULL DEFAULT 'custom',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'console_roles_kind_check'
      AND conrelid = '"__SCHEMA__".console_roles'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".console_roles
      ADD CONSTRAINT console_roles_kind_check
      CHECK (kind IN ('system', 'custom'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS console_roles_key_idx
  ON "__SCHEMA__".console_roles (key);

-- ─────────────────────────────────────────────────────────────
-- console_role_permissions —— 角色拥有的权限码
-- 权限码本身不建表：目录封闭，由 @cairn/shared 拥有。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "__SCHEMA__".console_role_permissions (
  console_role_id  UUID NOT NULL
    REFERENCES "__SCHEMA__".console_roles (id) ON DELETE CASCADE,
  permission       TEXT NOT NULL,
  PRIMARY KEY (console_role_id, permission)
);

CREATE INDEX IF NOT EXISTS console_role_permissions_perm_idx
  ON "__SCHEMA__".console_role_permissions (permission);

-- ─────────────────────────────────────────────────────────────
-- console_account_roles —— 账号 ↔ 角色
-- 删除角色时若仍被引用则拒绝（RESTRICT），避免权限被悄悄抽走。
-- assigned_by 也指向 console_accounts，同表多外键用角色前缀区分。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "__SCHEMA__".console_account_roles (
  console_account_id              UUID        NOT NULL
    REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE CASCADE,
  console_role_id                 UUID        NOT NULL
    REFERENCES "__SCHEMA__".console_roles (id) ON DELETE RESTRICT,
  assigned_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by_console_account_id  UUID
    REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE SET NULL,
  PRIMARY KEY (console_account_id, console_role_id)
);

CREATE INDEX IF NOT EXISTS console_account_roles_role_idx
  ON "__SCHEMA__".console_account_roles (console_role_id);

-- ─────────────────────────────────────────────────────────────
-- 系统角色 + 权限集（与 @cairn/shared SYSTEM_ROLE_DEFINITIONS 同步）
--
-- gen_random_uuid() 是 v4。这里只有三行、只在首次迁移执行一次，
-- 索引局部性无从谈起，不值得为它引入 v7 扩展；业务行一律走
-- packages/db/src/id.ts 的 newId()。
-- ─────────────────────────────────────────────────────────────
INSERT INTO "__SCHEMA__".console_roles (id, key, name, description, kind)
VALUES
  (gen_random_uuid(), 'admin',    'Administrator', 'Full access, including identity and permission management.', 'system'),
  (gen_random_uuid(), 'operator', 'Operator',      'Run and edit workflows. Cannot manage accounts or roles.',   'system'),
  (gen_random_uuid(), 'viewer',   'Viewer',        'Read-only access to the console.',                           'system')
ON CONFLICT (key) DO NOTHING;

-- 权限按 key 解析到 role_id——seed 里不出现 UUID 字面量。
INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
JOIN (VALUES
  -- admin：目录内全部权限
  ('admin', 'account:read'),
  ('admin', 'account:write'),
  ('admin', 'account:delete'),
  ('admin', 'role:read'),
  ('admin', 'role:write'),
  ('admin', 'role:delete'),
  ('admin', 'workflow:read'),
  ('admin', 'workflow:write'),
  ('admin', 'workflow:delete'),
  ('admin', 'run:read'),
  ('admin', 'run:execute'),
  ('admin', 'run:cancel'),
  ('admin', 'target:read'),
  ('admin', 'target:write'),
  ('admin', 'target:delete'),
  ('admin', 'settings:read'),
  ('admin', 'settings:write'),
  ('admin', 'audit:read'),
  -- operator：编排与执行，不含 IAM 写
  ('operator', 'account:read'),
  ('operator', 'role:read'),
  ('operator', 'workflow:read'),
  ('operator', 'workflow:write'),
  ('operator', 'workflow:delete'),
  ('operator', 'run:read'),
  ('operator', 'run:execute'),
  ('operator', 'run:cancel'),
  ('operator', 'target:read'),
  ('operator', 'target:write'),
  ('operator', 'target:delete'),
  ('operator', 'settings:read'),
  ('operator', 'audit:read'),
  -- viewer：只读
  ('viewer', 'account:read'),
  ('viewer', 'role:read'),
  ('viewer', 'workflow:read'),
  ('viewer', 'run:read'),
  ('viewer', 'target:read'),
  ('viewer', 'settings:read'),
  ('viewer', 'audit:read')
) AS p(role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 把旧的 accounts.role 列迁到绑定表，然后丢掉这一列。
-- 旧列存的是 key，按 key join 出 role 的 UUID。
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '__SCHEMA__'
      AND table_name = 'console_accounts'
      AND column_name = 'role'
  ) THEN
    INSERT INTO "__SCHEMA__".console_account_roles (console_account_id, console_role_id)
    SELECT a.id, r.id
    FROM "__SCHEMA__".console_accounts a
    JOIN "__SCHEMA__".console_roles r ON r.key = a.role
    ON CONFLICT DO NOTHING;

    ALTER TABLE "__SCHEMA__".console_accounts
      DROP CONSTRAINT IF EXISTS console_accounts_role_check;

    ALTER TABLE "__SCHEMA__".console_accounts
      DROP COLUMN role;
  END IF;
END $$;
