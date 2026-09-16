-- 0042：目标术语、修订与知识编写建议。

CREATE TABLE "__SCHEMA__".map_terminology_entries (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  request_key TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases JSONB NOT NULL,
  meaning TEXT NOT NULL,
  condition_snapshot JSONB,
  term_status TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  sources JSONB NOT NULL,
  created_by_console_account_id UUID NOT NULL,
  updated_by_console_account_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_terminology_entries_status_check
    CHECK (term_status IN ('candidate','confirmed','retired'))
);
CREATE UNIQUE INDEX map_terminology_entries_key_idx
  ON "__SCHEMA__".map_terminology_entries (target_id, request_key);
CREATE INDEX map_terminology_entries_target_idx
  ON "__SCHEMA__".map_terminology_entries (target_id, canonical_name);

CREATE TABLE "__SCHEMA__".map_terminology_revisions (
  id UUID PRIMARY KEY,
  term_id UUID NOT NULL REFERENCES "__SCHEMA__".map_terminology_entries(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  payload JSONB NOT NULL,
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_terminology_revisions_unique UNIQUE (term_id, revision)
);

CREATE TABLE "__SCHEMA__".map_authoring_proposals (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  scenario_id UUID NOT NULL REFERENCES "__SCHEMA__".scenarios(id) ON DELETE RESTRICT,
  request_key TEXT NOT NULL,
  accept_key TEXT,
  proposal_status TEXT NOT NULL,
  question TEXT NOT NULL,
  baseline JSONB NOT NULL,
  document JSONB,
  diffs JSONB NOT NULL,
  diagnostics JSONB NOT NULL,
  sources JSONB NOT NULL,
  unknowns JSONB NOT NULL,
  term_candidates JSONB NOT NULL,
  suggested_modules JSONB NOT NULL,
  suggested_bindings JSONB NOT NULL,
  accepted_revision INTEGER,
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_authoring_proposals_status_check
    CHECK (proposal_status IN (
      'requested','generating','proposed','needs_input','unsupported','failed','cancelled','accepted','stale','rejected'
    ))
);
CREATE UNIQUE INDEX map_authoring_proposals_key_idx
  ON "__SCHEMA__".map_authoring_proposals (scenario_id, request_key);
CREATE INDEX map_authoring_proposals_target_idx
  ON "__SCHEMA__".map_authoring_proposals (target_id, updated_at);
