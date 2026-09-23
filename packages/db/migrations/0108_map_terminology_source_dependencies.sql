-- 0108：平台助手知识来源依赖索引表，用于术语/知识的来源反向定位与读时复核。

CREATE TABLE "__SCHEMA__".map_terminology_source_dependencies (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE CASCADE,
  term_id UUID NOT NULL REFERENCES "__SCHEMA__".map_terminology_entries(id) ON DELETE CASCADE,
  term_revision INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX map_term_src_dep_lookup_idx
  ON "__SCHEMA__".map_terminology_source_dependencies (target_id, source_kind, source_id);

CREATE INDEX map_term_src_dep_term_idx
  ON "__SCHEMA__".map_terminology_source_dependencies (term_id, term_revision);
