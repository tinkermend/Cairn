-- Immutable publication command receipts for OCC-safe idempotent retries.
CREATE TABLE map_publication_commands (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  target_id VARCHAR(36) NOT NULL,
  command_key VARCHAR(192) NOT NULL,
  payload JSON NOT NULL,
  result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_publication_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_publication_commands_key_idx ON map_publication_commands(target_id, command_key);
