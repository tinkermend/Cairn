-- 0131：允许统一采集事实写入 map_observations；保留历史来源值以维持已有事实可读。
ALTER TABLE "__SCHEMA__".map_observations DROP CONSTRAINT map_observations_source_type_check;
ALTER TABLE "__SCHEMA__".map_observations
  ADD CONSTRAINT map_observations_source_type_check
  CHECK (source_type IN (
    'formal_run', 'trial', 'recorder', 'user_confirmed', 'probe', 'refresh',
    'ai_explore', 'imported_metadata', 'map_ingest'
  ));
