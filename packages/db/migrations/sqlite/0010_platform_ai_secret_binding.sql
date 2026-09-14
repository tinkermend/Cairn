CREATE TABLE platform_ai_secret_bindings (
  secret_id TEXT NOT NULL PRIMARY KEY,
  model_origin TEXT NOT NULL,
  FOREIGN KEY (secret_id) REFERENCES secrets(id) ON DELETE RESTRICT
);

CREATE TRIGGER platform_ai_secret_bindings_immutable BEFORE UPDATE ON platform_ai_secret_bindings BEGIN SELECT RAISE(ABORT, 'platform_ai_secret_bindings immutable'); END;
CREATE TRIGGER platform_ai_secret_bindings_no_delete BEFORE DELETE ON platform_ai_secret_bindings BEGIN SELECT RAISE(ABORT, 'platform_ai_secret_bindings immutable'); END;
