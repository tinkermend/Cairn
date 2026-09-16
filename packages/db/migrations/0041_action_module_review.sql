-- Action Module review: durable request receipts
CREATE TABLE "__SCHEMA__".action_module_receipts (
 id UUID PRIMARY KEY,
 actor_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
 idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 module_id UUID NOT NULL REFERENCES "__SCHEMA__".action_modules(id) ON DELETE RESTRICT,
 response JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX action_module_receipts_actor_key_idx ON "__SCHEMA__".action_module_receipts (actor_id, idempotency_key);
