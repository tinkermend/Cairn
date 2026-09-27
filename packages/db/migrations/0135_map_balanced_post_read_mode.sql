-- Opt-in map ingestion risk mode; NULL preserves existing policy digests and behavior.
ALTER TABLE "__SCHEMA__".target_access_policies
  ADD COLUMN post_read_mode TEXT NULL CHECK (post_read_mode IS NULL OR post_read_mode = 'balanced');
