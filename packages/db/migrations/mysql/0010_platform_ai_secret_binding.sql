CREATE TABLE platform_ai_secret_bindings (
  secret_id VARCHAR(36) NOT NULL PRIMARY KEY,
  model_origin LONGTEXT NOT NULL,
  FOREIGN KEY (secret_id) REFERENCES secrets(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TRIGGER platform_ai_secret_bindings_immutable BEFORE UPDATE ON platform_ai_secret_bindings FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_ai_secret_bindings immutable'; END;
CREATE TRIGGER platform_ai_secret_bindings_no_delete BEFORE DELETE ON platform_ai_secret_bindings FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_ai_secret_bindings immutable'; END;
