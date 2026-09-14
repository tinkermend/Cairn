CREATE TABLE recording_bindings (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  created_by_console_account_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  scenario_id VARCHAR(36) NOT NULL,
  draft_revision INT NOT NULL,
  insert_anchor JSON NOT NULL,
  ticket_hash VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  api_origin VARCHAR(256) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  upload_expires_at DATETIME(3) NOT NULL,
  recording_draft_id VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  claimed_at DATETIME(3) NULL,
  closed_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT recording_bindings_status_check CHECK (status IN ('issued','claimed','closed')),
  CONSTRAINT recording_bindings_revision_check CHECK (draft_revision >= 1),
  CONSTRAINT recording_bindings_actor_fkey FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id),
  CONSTRAINT recording_bindings_target_fkey FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT recording_bindings_scenario_fkey FOREIGN KEY (scenario_id) REFERENCES scenarios(id),
  CONSTRAINT recording_bindings_draft_fkey FOREIGN KEY (recording_draft_id) REFERENCES recording_drafts(id)
);

CREATE UNIQUE INDEX recording_bindings_ticket_hash_idx ON recording_bindings (ticket_hash);
CREATE INDEX recording_bindings_actor_created_idx ON recording_bindings (created_by_console_account_id, created_at);
CREATE INDEX recording_bindings_scenario_id_idx ON recording_bindings (scenario_id);

CREATE TABLE recording_import_receipts (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  scenario_id VARCHAR(36) NOT NULL,
  recording_draft_id VARCHAR(36) NOT NULL,
  created_by_console_account_id VARCHAR(36) NOT NULL,
  idempotency_key VARCHAR(256) NOT NULL,
  request_digest VARCHAR(64) NOT NULL,
  source_digest VARCHAR(64) NOT NULL,
  normalizer_version VARCHAR(64) NOT NULL,
  base_revision INT NOT NULL,
  new_revision INT NOT NULL,
  insert_anchor JSON NOT NULL,
  source_map JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT recording_import_receipts_revision_check CHECK (base_revision >= 1 AND new_revision > base_revision),
  CONSTRAINT recording_import_receipts_actor_fkey FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id),
  CONSTRAINT recording_import_receipts_scenario_fkey FOREIGN KEY (scenario_id) REFERENCES scenarios(id),
  CONSTRAINT recording_import_receipts_draft_fkey FOREIGN KEY (recording_draft_id) REFERENCES recording_drafts(id)
);

CREATE UNIQUE INDEX recording_import_receipts_scenario_draft_idx
  ON recording_import_receipts (scenario_id, recording_draft_id);
CREATE UNIQUE INDEX recording_import_receipts_actor_idempotency_idx
  ON recording_import_receipts (created_by_console_account_id, idempotency_key);
CREATE INDEX recording_import_receipts_scenario_id_idx ON recording_import_receipts (scenario_id);
