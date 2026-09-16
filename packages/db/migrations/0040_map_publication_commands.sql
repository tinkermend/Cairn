-- Immutable publication command receipts for OCC-safe idempotent retries.
CREATE TABLE "__SCHEMA__".map_publication_commands (
  id UUID NOT NULL PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  command_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX map_publication_commands_key_idx ON "__SCHEMA__".map_publication_commands(target_id, command_key);
