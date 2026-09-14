-- A model Secret keeps its service binding when configurations are disabled or restored.
CREATE TABLE "__SCHEMA__".platform_ai_secret_bindings (
  secret_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".secrets(id) ON DELETE RESTRICT,
  model_origin TEXT NOT NULL
);

CREATE FUNCTION "__SCHEMA__".reject_platform_ai_secret_binding_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'platform_ai_secret_bindings are immutable'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER platform_ai_secret_bindings_immutable
  BEFORE UPDATE OR DELETE ON "__SCHEMA__".platform_ai_secret_bindings
  FOR EACH ROW EXECUTE FUNCTION "__SCHEMA__".reject_platform_ai_secret_binding_mutation();
