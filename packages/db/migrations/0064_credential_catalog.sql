-- 0064：凭据目录。存量按已证明的绑定登记；目录 ID 使用消费对象稳定 ID，
-- 便于幂等回填，不解密、不伪造期限或负责人。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".credentials (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_console_account_id UUID,
  notes TEXT,
  purpose TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  management_status TEXT NOT NULL DEFAULT 'active',
  current_version_id UUID,
  revision INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credentials_type_check CHECK (type IN ('target_password', 'model_key', 'alert_webhook', 'service_key')),
  CONSTRAINT credentials_source_check CHECK (source IN ('target_account', 'platform_ai', 'alert_channel', 'service_credential')),
  CONSTRAINT credentials_management_status_check CHECK (management_status IN ('active', 'disabled')),
  CONSTRAINT credentials_revision_check CHECK (revision >= 1)
);

CREATE INDEX IF NOT EXISTS credentials_owner_idx ON "__SCHEMA__".credentials (owner_console_account_id);
CREATE INDEX IF NOT EXISTS credentials_type_updated_idx ON "__SCHEMA__".credentials (type, updated_at, id);
CREATE INDEX IF NOT EXISTS credentials_status_updated_idx ON "__SCHEMA__".credentials (management_status, updated_at, id);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".credential_bindings (
  id UUID PRIMARY KEY,
  credential_id UUID NOT NULL REFERENCES "__SCHEMA__".credentials (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  target_id UUID,
  target_account_id UUID,
  model_origin TEXT,
  model_slot TEXT,
  alert_channel_id TEXT,
  service_credential_id UUID,
  identity_username TEXT,
  identity_revision INT,
  identity_confirm_status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credential_bindings_kind_check CHECK (kind IN ('target_account', 'model_config', 'alert_channel', 'service_credential')),
  CONSTRAINT credential_bindings_identity_status_check CHECK (identity_confirm_status IN ('confirmed', 'pending_reconfirm'))
);

CREATE UNIQUE INDEX IF NOT EXISTS credential_bindings_credential_idx ON "__SCHEMA__".credential_bindings (credential_id);
CREATE UNIQUE INDEX IF NOT EXISTS credential_bindings_target_account_idx ON "__SCHEMA__".credential_bindings (target_account_id) WHERE target_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS credential_bindings_alert_channel_idx ON "__SCHEMA__".credential_bindings (alert_channel_id) WHERE alert_channel_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS credential_bindings_service_credential_idx ON "__SCHEMA__".credential_bindings (service_credential_id) WHERE service_credential_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS credential_bindings_target_idx ON "__SCHEMA__".credential_bindings (target_id);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".credential_versions (
  id UUID PRIMARY KEY,
  credential_id UUID NOT NULL REFERENCES "__SCHEMA__".credentials (id) ON DELETE RESTRICT,
  secret_provider TEXT,
  secret_id UUID,
  material_status TEXT NOT NULL,
  identity_revision INT,
  identity_username TEXT,
  registered_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credential_versions_status_check CHECK (material_status IN ('current', 'superseded', 'revoked', 'cleared', 'unavailable'))
);

CREATE INDEX IF NOT EXISTS credential_versions_credential_idx ON "__SCHEMA__".credential_versions (credential_id, registered_at);
CREATE INDEX IF NOT EXISTS credential_versions_secret_idx ON "__SCHEMA__".credential_versions (secret_id) WHERE secret_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS "__SCHEMA__".credential_maintenance_policies (
  credential_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".credentials (id) ON DELETE RESTRICT,
  mode TEXT NOT NULL,
  amount INT,
  time_zone TEXT,
  validity_started_at TIMESTAMPTZ,
  maintenance_due_at TIMESTAMPTZ,
  issuer_expires_at TIMESTAMPTZ,
  issuer_expiry_source TEXT NOT NULL DEFAULT 'unknown',
  expiry_reminder_lead_days INT NOT NULL DEFAULT 14,
  revision INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credential_policies_mode_check CHECK (mode IN ('days', 'months', 'permanent', 'unknown')),
  CONSTRAINT credential_policies_issuer_source_check CHECK (issuer_expiry_source IN ('manual_declaration', 'provider', 'issued_by_cairn', 'unknown')),
  CONSTRAINT credential_policies_lead_check CHECK (expiry_reminder_lead_days >= 0 AND expiry_reminder_lead_days <= 365),
  CONSTRAINT credential_policies_amount_check CHECK (amount IS NULL OR amount > 0)
);

CREATE INDEX IF NOT EXISTS credential_policies_due_idx ON "__SCHEMA__".credential_maintenance_policies (maintenance_due_at);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".credential_verifications (
  id UUID PRIMARY KEY,
  credential_id UUID NOT NULL REFERENCES "__SCHEMA__".credentials (id) ON DELETE RESTRICT,
  version_id UUID NOT NULL REFERENCES "__SCHEMA__".credential_versions (id) ON DELETE RESTRICT,
  identity_revision INT,
  session_id TEXT,
  session_generation INT,
  source TEXT NOT NULL,
  source_id TEXT,
  outcome TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credential_verifications_source_check CHECK (source IN ('run', 'maintenance')),
  CONSTRAINT credential_verifications_outcome_check CHECK (outcome IN ('pending', 'verified', 'failed', 'inconclusive'))
);

CREATE INDEX IF NOT EXISTS credential_verifications_current_idx ON "__SCHEMA__".credential_verifications (credential_id, verified_at DESC);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".credential_batches (
  id UUID PRIMARY KEY,
  actor_console_account_id UUID NOT NULL,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credential_batches_kind_check CHECK (kind IN ('password_replace', 'metadata'))
);

CREATE UNIQUE INDEX IF NOT EXISTS credential_batches_actor_idempotency_idx
  ON "__SCHEMA__".credential_batches (actor_console_account_id, idempotency_key);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".credential_batch_items (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES "__SCHEMA__".credential_batches (id) ON DELETE RESTRICT,
  credential_id UUID NOT NULL,
  target_id UUID,
  target_account_id UUID,
  expected_revision INT NOT NULL,
  item_idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  result_revision INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credential_batch_items_status_check CHECK (status IN ('pending_material', 'succeeded', 'failed', 'conflict'))
);

CREATE UNIQUE INDEX IF NOT EXISTS credential_batch_items_idempotency_idx
  ON "__SCHEMA__".credential_batch_items (batch_id, item_idempotency_key);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".credential_reminders (
  id UUID PRIMARY KEY,
  credential_id UUID NOT NULL REFERENCES "__SCHEMA__".credentials (id) ON DELETE RESTRICT,
  version_id UUID NOT NULL,
  policy_revision INT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  delivery_status TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credential_reminders_stage_check CHECK (stage IN ('approaching', 'due')),
  CONSTRAINT credential_reminders_status_check CHECK (status IN ('open', 'closed')),
  CONSTRAINT credential_reminders_delivery_check CHECK (
    delivery_status IS NULL OR delivery_status IN ('pending', 'sent', 'failed', 'suppressed')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS credential_reminders_identity_idx
  ON "__SCHEMA__".credential_reminders (credential_id, version_id, policy_revision, stage);

INSERT INTO "__SCHEMA__".credentials (id, type, source, name, management_status, revision, created_at, updated_at)
SELECT a.id, 'target_password', 'target_account', a.display_name, 'active', 1, a.created_at, a.updated_at
FROM "__SCHEMA__".target_accounts a
WHERE a.deleted_at IS NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO "__SCHEMA__".credential_bindings (
  id, credential_id, kind, target_id, target_account_id, identity_username, identity_revision, identity_confirm_status, created_at, updated_at
)
SELECT a.id, a.id, 'target_account', a.target_id, a.id, a.username, a.config_revision, 'confirmed', a.created_at, a.updated_at
FROM "__SCHEMA__".target_accounts a
WHERE a.deleted_at IS NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO "__SCHEMA__".credential_versions (
  id, credential_id, secret_provider, secret_id, material_status, identity_revision, identity_username, registered_at, created_at
)
SELECT a.secret_id, a.id, a.secret_provider, a.secret_id, 'current', a.config_revision, a.username, a.updated_at, a.updated_at
FROM "__SCHEMA__".target_accounts a
WHERE a.deleted_at IS NULL AND a.secret_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

UPDATE "__SCHEMA__".credentials c
SET current_version_id = a.secret_id
FROM "__SCHEMA__".target_accounts a
WHERE c.id = a.id AND a.secret_id IS NOT NULL AND c.current_version_id IS NULL;

INSERT INTO "__SCHEMA__".credentials (id, type, source, name, management_status, revision, created_at, updated_at)
SELECT b.secret_id, 'model_key', 'platform_ai', '模型服务 Key', 'active', 1, now(), now()
FROM "__SCHEMA__".platform_ai_secret_bindings b
ON CONFLICT (id) DO NOTHING;

INSERT INTO "__SCHEMA__".credential_bindings (
  id, credential_id, kind, model_origin, identity_confirm_status, created_at, updated_at
)
SELECT b.secret_id, b.secret_id, 'model_config', b.model_origin, 'confirmed', now(), now()
FROM "__SCHEMA__".platform_ai_secret_bindings b
ON CONFLICT (id) DO NOTHING;

INSERT INTO "__SCHEMA__".credential_versions (
  id, credential_id, secret_provider, secret_id, material_status, registered_at, created_at
)
SELECT b.secret_id, b.secret_id, 'local', b.secret_id, 'current', now(), now()
FROM "__SCHEMA__".platform_ai_secret_bindings b
ON CONFLICT (id) DO NOTHING;

UPDATE "__SCHEMA__".credentials c
SET current_version_id = b.secret_id
FROM "__SCHEMA__".platform_ai_secret_bindings b
WHERE c.id = b.secret_id AND c.current_version_id IS NULL;

INSERT INTO "__SCHEMA__".credentials (id, type, source, name, management_status, revision, created_at, updated_at)
SELECT sc.id, 'service_key', 'service_credential', sc.name, 'active', 1, sc.created_at, sc.created_at
FROM "__SCHEMA__".service_credentials sc
ON CONFLICT (id) DO NOTHING;

INSERT INTO "__SCHEMA__".credential_bindings (
  id, credential_id, kind, service_credential_id, identity_confirm_status, created_at, updated_at
)
SELECT sc.id, sc.id, 'service_credential', sc.id, 'confirmed', sc.created_at, sc.created_at
FROM "__SCHEMA__".service_credentials sc
ON CONFLICT (id) DO NOTHING;

INSERT INTO "__SCHEMA__".credential_maintenance_policies (
  credential_id, mode, issuer_expires_at, issuer_expiry_source, expiry_reminder_lead_days, revision, updated_at
)
SELECT c.id,
  'unknown',
  CASE WHEN c.type = 'service_key' THEN sc.expires_at ELSE NULL END,
  CASE WHEN c.type = 'service_key' THEN 'issued_by_cairn' ELSE 'unknown' END,
  14,
  1,
  c.updated_at
FROM "__SCHEMA__".credentials c
LEFT JOIN "__SCHEMA__".service_credentials sc ON sc.id = c.id
ON CONFLICT (credential_id) DO NOTHING;
