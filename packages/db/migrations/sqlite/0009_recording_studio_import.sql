CREATE TABLE recording_bindings (
  id TEXT NOT NULL PRIMARY KEY,
  created_by_console_account_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
  insert_anchor TEXT NOT NULL CHECK (json_valid(insert_anchor)),
  ticket_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued','claimed','closed')),
  api_origin TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  upload_expires_at TEXT NOT NULL,
  recording_draft_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  claimed_at TEXT,
  closed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE RESTRICT,
  FOREIGN KEY (recording_draft_id) REFERENCES recording_drafts(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX recording_bindings_ticket_hash_idx ON recording_bindings (ticket_hash);
CREATE INDEX recording_bindings_actor_created_idx ON recording_bindings (created_by_console_account_id, created_at);
CREATE INDEX recording_bindings_scenario_id_idx ON recording_bindings (scenario_id);

CREATE TABLE recording_import_receipts (
  id TEXT NOT NULL PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  recording_draft_id TEXT NOT NULL,
  created_by_console_account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  normalizer_version TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  new_revision INTEGER NOT NULL,
  insert_anchor TEXT NOT NULL CHECK (json_valid(insert_anchor)),
  source_map TEXT NOT NULL CHECK (json_valid(source_map)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (base_revision >= 1 AND new_revision > base_revision),
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE RESTRICT,
  FOREIGN KEY (recording_draft_id) REFERENCES recording_drafts(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX recording_import_receipts_scenario_draft_idx
  ON recording_import_receipts (scenario_id, recording_draft_id);
CREATE UNIQUE INDEX recording_import_receipts_actor_idempotency_idx
  ON recording_import_receipts (created_by_console_account_id, idempotency_key);
CREATE INDEX recording_import_receipts_scenario_id_idx ON recording_import_receipts (scenario_id);
