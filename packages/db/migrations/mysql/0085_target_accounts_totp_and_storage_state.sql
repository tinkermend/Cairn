-- 0101 的 MySQL 等价增量：目标账号扩展 TOTP 2FA 凭据与 StorageState 免登凭据支持

ALTER TABLE target_accounts
  ADD COLUMN totp_secret_id VARCHAR(36) NULL,
  ADD COLUMN storage_state_secret_id VARCHAR(36) NULL,
  ADD COLUMN storage_state_updated_at DATETIME(3) NULL;

ALTER TABLE target_accounts
  ADD CONSTRAINT target_accounts_totp_secret_fk FOREIGN KEY (totp_secret_id) REFERENCES secrets(id) ON DELETE SET NULL,
  ADD CONSTRAINT target_accounts_storage_state_secret_fk FOREIGN KEY (storage_state_secret_id) REFERENCES secrets(id) ON DELETE SET NULL;
