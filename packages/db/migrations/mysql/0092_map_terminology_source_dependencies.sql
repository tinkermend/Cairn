-- 0092：平台助手知识来源依赖索引表，用于术语/知识的来源反向定位与读时复核（MySQL 等价）。

CREATE TABLE map_terminology_source_dependencies (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  target_id VARCHAR(36) NOT NULL,
  term_id VARCHAR(36) NOT NULL,
  term_revision INT NOT NULL,
  source_kind VARCHAR(64) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  source_revision VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_map_term_src_dep_target FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE,
  CONSTRAINT fk_map_term_src_dep_term FOREIGN KEY (term_id) REFERENCES map_terminology_entries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX map_term_src_dep_lookup_idx
  ON map_terminology_source_dependencies (target_id, source_kind, source_id);

CREATE INDEX map_term_src_dep_term_idx
  ON map_terminology_source_dependencies (term_id, term_revision);
