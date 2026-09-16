-- Action Module review: durable request receipts
CREATE TABLE action_module_receipts (
 id TEXT PRIMARY KEY,
 actor_id TEXT NOT NULL REFERENCES console_accounts(id) ON DELETE RESTRICT,
 idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 module_id TEXT NOT NULL REFERENCES action_modules(id) ON DELETE RESTRICT,
 response TEXT NOT NULL CHECK(json_valid(response)),
 created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX action_module_receipts_actor_key_idx ON action_module_receipts (actor_id, idempotency_key);
