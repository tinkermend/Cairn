-- 0101：目标账号扩展 TOTP 2FA 凭据与 StorageState 免登凭据支持
ALTER TABLE "__SCHEMA__".target_accounts
  ADD COLUMN IF NOT EXISTS totp_secret_id UUID REFERENCES "__SCHEMA__".secrets (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS storage_state_secret_id UUID REFERENCES "__SCHEMA__".secrets (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS storage_state_updated_at TIMESTAMPTZ;
