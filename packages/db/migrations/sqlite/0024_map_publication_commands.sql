-- Immutable publication command receipts for OCC-safe idempotent retries.
CREATE TABLE map_publication_commands (
  id TEXT NOT NULL PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE RESTRICT,
  command_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX map_publication_commands_key_idx ON map_publication_commands(target_id, command_key);
