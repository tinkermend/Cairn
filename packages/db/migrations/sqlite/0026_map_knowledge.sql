-- 0042 的 SQLite 等价增量：目标术语、修订与知识编写建议。

CREATE TABLE map_terminology_entries (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases TEXT NOT NULL,
  meaning TEXT NOT NULL,
  condition_snapshot TEXT,
  term_status TEXT NOT NULL CHECK (term_status IN ('candidate','confirmed','retired')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  sources TEXT NOT NULL,
  created_by_console_account_id TEXT NOT NULL,
  updated_by_console_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_terminology_entries_pkey PRIMARY KEY (id),
  CONSTRAINT map_terminology_entries_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_terminology_entries_key_idx ON map_terminology_entries (target_id, request_key);
CREATE INDEX map_terminology_entries_target_idx ON map_terminology_entries (target_id, canonical_name);

CREATE TABLE map_terminology_revisions (
  id TEXT NOT NULL,
  term_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  payload TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_terminology_revisions_pkey PRIMARY KEY (id),
  CONSTRAINT map_terminology_revisions_unique UNIQUE (term_id, revision),
  CONSTRAINT map_terminology_revisions_term_fk FOREIGN KEY (term_id) REFERENCES map_terminology_entries(id) ON DELETE RESTRICT
);

CREATE TABLE map_authoring_proposals (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  accept_key TEXT,
  proposal_status TEXT NOT NULL CHECK (proposal_status IN (
    'requested','generating','proposed','needs_input','unsupported','failed','cancelled','accepted','stale','rejected'
  )),
  question TEXT NOT NULL,
  baseline TEXT NOT NULL,
  document TEXT,
  diffs TEXT NOT NULL,
  diagnostics TEXT NOT NULL,
  sources TEXT NOT NULL,
  unknowns TEXT NOT NULL,
  term_candidates TEXT NOT NULL,
  suggested_modules TEXT NOT NULL,
  suggested_bindings TEXT NOT NULL,
  accepted_revision INTEGER,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_authoring_proposals_pkey PRIMARY KEY (id),
  CONSTRAINT map_authoring_proposals_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT map_authoring_proposals_scenario_fk FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_authoring_proposals_key_idx ON map_authoring_proposals (scenario_id, request_key);
CREATE INDEX map_authoring_proposals_target_idx ON map_authoring_proposals (target_id, updated_at);
