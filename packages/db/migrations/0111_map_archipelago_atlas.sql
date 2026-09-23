-- 0111：知识群岛页面聚合查询索引（map_projection_assets）。

CREATE INDEX map_projection_assets_page_idx ON "__SCHEMA__".map_projection_assets (projection_id, page_id);
