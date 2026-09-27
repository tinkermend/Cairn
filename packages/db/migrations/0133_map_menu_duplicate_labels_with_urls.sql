-- 同名菜单可出现在不同导航组；有 URL 时由 URL 区分，纯展开菜单仍按标签唯一。
DROP INDEX "__SCHEMA__".map_menu_entries_active_label;
-- portability-exception: 同名菜单可出现在不同导航组；有 URL 时由 URL 区分，仅纯展开菜单保持标签唯一
CREATE UNIQUE INDEX map_menu_entries_active_label ON "__SCHEMA__".map_menu_entries
  (target_id, menu_label_key, active_guard) WHERE entry_url IS NULL;
