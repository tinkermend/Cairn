ALTER TABLE "__SCHEMA__".map_ingest_pages
  ADD COLUMN presentation_state_key TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN arrival_method TEXT NOT NULL DEFAULT 'goto';

ALTER TABLE "__SCHEMA__".map_ingest_pages
  ADD CONSTRAINT map_ingest_pages_arrival_method_check
  CHECK (arrival_method IN ('goto', 'reveal', 'opaque_click'));
