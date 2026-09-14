-- Repair databases which applied 0019 with a different connection search_path.
-- Validate existing grants in the same transaction; invalid references must fail the upgrade.
ALTER TABLE "__SCHEMA__".credential_target_grants
  DROP CONSTRAINT credential_target_grants_target_id_fkey,
  ADD CONSTRAINT credential_target_grants_target_id_fkey
    FOREIGN KEY (target_id) REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT;
