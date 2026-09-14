-- 0025：平台发起录制绑定与 Scenario 回填回执。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".recording_bindings (
  id                              UUID        PRIMARY KEY,
  created_by_console_account_id   UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  target_id                       UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".targets (id) ON DELETE RESTRICT,
  scenario_id                     UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".scenarios (id) ON DELETE RESTRICT,
  draft_revision                  INTEGER     NOT NULL,
  insert_anchor                   JSONB       NOT NULL,
  ticket_hash                     TEXT        NOT NULL,
  status                          TEXT        NOT NULL,
  api_origin                      TEXT        NOT NULL,
  expires_at                      TIMESTAMPTZ NOT NULL,
  upload_expires_at               TIMESTAMPTZ NOT NULL,
  recording_draft_id              UUID        REFERENCES "__SCHEMA__".recording_drafts (id) ON DELETE RESTRICT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at                      TIMESTAMPTZ,
  closed_at                       TIMESTAMPTZ,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recording_bindings_status_check
    CHECK (status IN ('issued', 'claimed', 'closed')),
  CONSTRAINT recording_bindings_revision_check
    CHECK (draft_revision >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS recording_bindings_ticket_hash_idx
  ON "__SCHEMA__".recording_bindings (ticket_hash);

CREATE INDEX IF NOT EXISTS recording_bindings_actor_created_idx
  ON "__SCHEMA__".recording_bindings (created_by_console_account_id, created_at);

CREATE INDEX IF NOT EXISTS recording_bindings_scenario_id_idx
  ON "__SCHEMA__".recording_bindings (scenario_id);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".recording_import_receipts (
  id                              UUID        PRIMARY KEY,
  scenario_id                     UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".scenarios (id) ON DELETE RESTRICT,
  recording_draft_id              UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".recording_drafts (id) ON DELETE RESTRICT,
  created_by_console_account_id   UUID        NOT NULL
                                              REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE RESTRICT,
  idempotency_key                 TEXT        NOT NULL,
  request_digest                  TEXT        NOT NULL,
  source_digest                   TEXT        NOT NULL,
  normalizer_version              TEXT        NOT NULL,
  base_revision                   INTEGER     NOT NULL,
  new_revision                    INTEGER     NOT NULL,
  insert_anchor                   JSONB       NOT NULL,
  source_map                      JSONB       NOT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recording_import_receipts_revision_check
    CHECK (base_revision >= 1 AND new_revision > base_revision),
  CONSTRAINT recording_import_receipts_source_map_array
    CHECK (jsonb_typeof(source_map) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS recording_import_receipts_scenario_draft_idx
  ON "__SCHEMA__".recording_import_receipts (scenario_id, recording_draft_id);

CREATE UNIQUE INDEX IF NOT EXISTS recording_import_receipts_actor_idempotency_idx
  ON "__SCHEMA__".recording_import_receipts (created_by_console_account_id, idempotency_key);

CREATE INDEX IF NOT EXISTS recording_import_receipts_scenario_id_idx
  ON "__SCHEMA__".recording_import_receipts (scenario_id);
