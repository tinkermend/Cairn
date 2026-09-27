-- Keep the default policy unchanged. An empty rule set is omitted from the frozen policy digest.
ALTER TABLE "__SCHEMA__".target_access_policies
  ADD COLUMN verified_non_content_requests_json JSONB NOT NULL DEFAULT '[]';
