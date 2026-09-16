-- Action Module review: durable request receipts
CREATE TABLE action_module_receipts (
 id VARCHAR(36) PRIMARY KEY,
 actor_id VARCHAR(36) NOT NULL,
 idempotency_key VARCHAR(128) NOT NULL,
 request_digest TEXT NOT NULL,
 module_id VARCHAR(36) NOT NULL,
 response JSON NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY (actor_id) REFERENCES console_accounts(id) ON DELETE RESTRICT,
 FOREIGN KEY (module_id) REFERENCES action_modules(id) ON DELETE RESTRICT,
 UNIQUE KEY action_module_receipts_actor_key_idx (actor_id, idempotency_key)
);
