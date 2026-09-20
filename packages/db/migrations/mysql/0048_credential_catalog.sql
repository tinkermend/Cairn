-- 0048：凭据目录。存量按消费对象稳定 ID 幂等登记；不解密、不伪造期限。

CREATE TABLE credentials (
  id VARCHAR(36) NOT NULL,
  type VARCHAR(32) NOT NULL,
  source VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  owner_console_account_id VARCHAR(36) NULL,
  notes TEXT NULL,
  purpose VARCHAR(256) NULL,
  tags JSON NOT NULL,
  management_status VARCHAR(16) NOT NULL DEFAULT 'active',
  current_version_id VARCHAR(36) NULL,
  revision INT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT credentials_type_check CHECK (type IN ('target_password', 'model_key', 'alert_webhook', 'service_key')),
  CONSTRAINT credentials_source_check CHECK (source IN ('target_account', 'platform_ai', 'alert_channel', 'service_credential')),
  CONSTRAINT credentials_management_status_check CHECK (management_status IN ('active', 'disabled')),
  CONSTRAINT credentials_revision_check CHECK (revision >= 1)
);

CREATE INDEX credentials_owner_idx ON credentials (owner_console_account_id);
CREATE INDEX credentials_type_updated_idx ON credentials (type, updated_at, id);
CREATE INDEX credentials_status_updated_idx ON credentials (management_status, updated_at, id);

CREATE TABLE credential_bindings (
  id VARCHAR(36) NOT NULL,
  credential_id VARCHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  target_id VARCHAR(36) NULL,
  target_account_id VARCHAR(36) NULL,
  model_origin VARCHAR(512) NULL,
  model_slot VARCHAR(32) NULL,
  alert_channel_id VARCHAR(64) NULL,
  service_credential_id VARCHAR(36) NULL,
  identity_username VARCHAR(256) NULL,
  identity_revision INT NULL,
  identity_confirm_status VARCHAR(32) NOT NULL DEFAULT 'confirmed',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT credential_bindings_kind_check CHECK (kind IN ('target_account', 'model_config', 'alert_channel', 'service_credential')),
  CONSTRAINT credential_bindings_identity_status_check CHECK (identity_confirm_status IN ('confirmed', 'pending_reconfirm'))
);

CREATE UNIQUE INDEX credential_bindings_credential_idx ON credential_bindings (credential_id);
CREATE UNIQUE INDEX credential_bindings_target_account_idx ON credential_bindings (target_account_id);
CREATE UNIQUE INDEX credential_bindings_alert_channel_idx ON credential_bindings (alert_channel_id);
CREATE UNIQUE INDEX credential_bindings_service_credential_idx ON credential_bindings (service_credential_id);
CREATE INDEX credential_bindings_target_idx ON credential_bindings (target_id);

CREATE TABLE credential_versions (
  id VARCHAR(36) NOT NULL,
  credential_id VARCHAR(36) NOT NULL,
  secret_provider VARCHAR(64) NULL,
  secret_id VARCHAR(36) NULL,
  material_status VARCHAR(32) NOT NULL,
  identity_revision INT NULL,
  identity_username VARCHAR(256) NULL,
  registered_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  revoke_reason VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT credential_versions_status_check CHECK (material_status IN ('current', 'superseded', 'revoked', 'cleared', 'unavailable'))
);

CREATE INDEX credential_versions_credential_idx ON credential_versions (credential_id, registered_at);
CREATE INDEX credential_versions_secret_idx ON credential_versions (secret_id);

CREATE TABLE credential_maintenance_policies (
  credential_id VARCHAR(36) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  amount INT NULL,
  time_zone VARCHAR(64) NULL,
  validity_started_at DATETIME(3) NULL,
  maintenance_due_at DATETIME(3) NULL,
  issuer_expires_at DATETIME(3) NULL,
  issuer_expiry_source VARCHAR(32) NOT NULL DEFAULT 'unknown',
  expiry_reminder_lead_days INT NOT NULL DEFAULT 14,
  revision INT NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (credential_id),
  CONSTRAINT credential_policies_mode_check CHECK (mode IN ('days', 'months', 'permanent', 'unknown')),
  CONSTRAINT credential_policies_issuer_source_check CHECK (issuer_expiry_source IN ('manual_declaration', 'provider', 'issued_by_cairn', 'unknown')),
  CONSTRAINT credential_policies_lead_check CHECK (expiry_reminder_lead_days >= 0 AND expiry_reminder_lead_days <= 365),
  CONSTRAINT credential_policies_amount_check CHECK ((amount IS NULL) OR (amount > 0))
);

CREATE INDEX credential_policies_due_idx ON credential_maintenance_policies (maintenance_due_at);

CREATE TABLE credential_verifications (
  id VARCHAR(36) NOT NULL,
  credential_id VARCHAR(36) NOT NULL,
  version_id VARCHAR(36) NOT NULL,
  identity_revision INT NULL,
  session_id VARCHAR(64) NULL,
  session_generation INT NULL,
  source VARCHAR(32) NOT NULL,
  source_id VARCHAR(64) NULL,
  outcome VARCHAR(32) NOT NULL,
  verified_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT credential_verifications_source_check CHECK (source IN ('run', 'maintenance')),
  CONSTRAINT credential_verifications_outcome_check CHECK (outcome IN ('pending', 'verified', 'failed', 'inconclusive'))
);

CREATE INDEX credential_verifications_current_idx ON credential_verifications (credential_id, verified_at);

CREATE TABLE credential_batches (
  id VARCHAR(36) NOT NULL,
  actor_console_account_id VARCHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT credential_batches_kind_check CHECK (kind IN ('password_replace', 'metadata'))
);

CREATE UNIQUE INDEX credential_batches_actor_idempotency_idx
  ON credential_batches (actor_console_account_id, idempotency_key);

CREATE TABLE credential_batch_items (
  id VARCHAR(36) NOT NULL,
  batch_id VARCHAR(36) NOT NULL,
  credential_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NULL,
  target_account_id VARCHAR(36) NULL,
  expected_revision INT NOT NULL,
  item_idempotency_key VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(256) NULL,
  result_revision INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT credential_batch_items_status_check CHECK (status IN ('pending_material', 'succeeded', 'failed', 'conflict'))
);

CREATE UNIQUE INDEX credential_batch_items_idempotency_idx
  ON credential_batch_items (batch_id, item_idempotency_key);

CREATE TABLE credential_reminders (
  id VARCHAR(36) NOT NULL,
  credential_id VARCHAR(36) NOT NULL,
  version_id VARCHAR(36) NOT NULL,
  policy_revision INT NOT NULL,
  stage VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  delivery_status VARCHAR(16) NULL,
  last_error VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT credential_reminders_stage_check CHECK (stage IN ('approaching', 'due')),
  CONSTRAINT credential_reminders_status_check CHECK (status IN ('open', 'closed')),
  CONSTRAINT credential_reminders_delivery_check CHECK (
    (delivery_status IS NULL) OR (delivery_status IN ('pending', 'sent', 'failed', 'suppressed'))
  )
);

CREATE UNIQUE INDEX credential_reminders_identity_idx
  ON credential_reminders (credential_id, version_id, policy_revision, stage);

INSERT IGNORE INTO credentials (id, type, source, name, management_status, revision, created_at, updated_at, tags)
SELECT a.id, 'target_password', 'target_account', a.display_name, 'active', 1, a.created_at, a.updated_at, JSON_ARRAY()
FROM target_accounts a
WHERE a.deleted_at IS NULL;

INSERT IGNORE INTO credential_bindings (
  id, credential_id, kind, target_id, target_account_id, identity_username, identity_revision, identity_confirm_status, created_at, updated_at
)
SELECT a.id, a.id, 'target_account', a.target_id, a.id, a.username, a.config_revision, 'confirmed', a.created_at, a.updated_at
FROM target_accounts a
WHERE a.deleted_at IS NULL;

INSERT IGNORE INTO credential_versions (
  id, credential_id, secret_provider, secret_id, material_status, identity_revision, identity_username, registered_at, created_at
)
SELECT a.secret_id, a.id, a.secret_provider, a.secret_id, 'current', a.config_revision, a.username, a.updated_at, a.updated_at
FROM target_accounts a
WHERE a.deleted_at IS NULL AND a.secret_id IS NOT NULL;

UPDATE credentials c
JOIN target_accounts a ON a.id = c.id
SET c.current_version_id = a.secret_id
WHERE a.secret_id IS NOT NULL AND c.current_version_id IS NULL;

INSERT IGNORE INTO credentials (id, type, source, name, management_status, revision, created_at, updated_at, tags)
SELECT b.secret_id, 'model_key', 'platform_ai', '模型服务 Key', 'active', 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), JSON_ARRAY()
FROM platform_ai_secret_bindings b;

INSERT IGNORE INTO credential_bindings (
  id, credential_id, kind, model_origin, identity_confirm_status, created_at, updated_at
)
SELECT b.secret_id, b.secret_id, 'model_config', b.model_origin, 'confirmed', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM platform_ai_secret_bindings b;

INSERT IGNORE INTO credential_versions (
  id, credential_id, secret_provider, secret_id, material_status, registered_at, created_at
)
SELECT b.secret_id, b.secret_id, 'local', b.secret_id, 'current', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM platform_ai_secret_bindings b;

UPDATE credentials c
JOIN platform_ai_secret_bindings b ON b.secret_id = c.id
SET c.current_version_id = b.secret_id
WHERE c.current_version_id IS NULL;

INSERT IGNORE INTO credentials (id, type, source, name, management_status, revision, created_at, updated_at, tags)
SELECT sc.id, 'service_key', 'service_credential', sc.name, 'active', 1, sc.created_at, sc.created_at, JSON_ARRAY()
FROM service_credentials sc;

INSERT IGNORE INTO credential_bindings (
  id, credential_id, kind, service_credential_id, identity_confirm_status, created_at, updated_at
)
SELECT sc.id, sc.id, 'service_credential', sc.id, 'confirmed', sc.created_at, sc.created_at
FROM service_credentials sc;

INSERT IGNORE INTO credential_maintenance_policies (
  credential_id, mode, issuer_expires_at, issuer_expiry_source, expiry_reminder_lead_days, revision, updated_at
)
SELECT c.id,
  'unknown',
  CASE WHEN c.type = 'service_key' THEN sc.expires_at ELSE NULL END,
  CASE WHEN c.type = 'service_key' THEN 'issued_by_cairn' ELSE 'unknown' END,
  14,
  1,
  c.updated_at
FROM credentials c
LEFT JOIN service_credentials sc ON sc.id = c.id;
