-- 0128：下线旧地图采集（probe / refresh / explore、安全进入路径、探索策略、候选审核、单跳试跑与 map_refresh 调度），
-- 为统一只读采集 map_ingest 让路。先删数据再删表；地图作业 Run 本身（runs / 步骤 / 证据）保留，只断开作业记录。
-- 目标知识事实（资产、投影、release、explore_states、target_state_rules）保留。

-- 1. 探索事实与探索策略
DROP TABLE "__SCHEMA__".explore_traversals;
DROP TABLE "__SCHEMA__".explore_reviews;
DROP TABLE "__SCHEMA__".explore_discoveries;
DROP TABLE "__SCHEMA__".explore_state_recipes;
DROP TABLE "__SCHEMA__".explore_entry_request_profiles;
DROP TABLE "__SCHEMA__".map_exploration_policy_commands;
DROP TABLE "__SCHEMA__".map_exploration_policies;

-- 2. map_refresh 调度及其修订、事件、窗口
UPDATE "__SCHEMA__".schedule_occurrences SET job_id = NULL WHERE job_id IS NOT NULL;
DELETE FROM "__SCHEMA__".schedule_events
WHERE schedule_id IN (SELECT id FROM "__SCHEMA__".schedules WHERE consumer_key = 'map_refresh');
DELETE FROM "__SCHEMA__".schedule_occurrences
WHERE schedule_id IN (SELECT id FROM "__SCHEMA__".schedules WHERE consumer_key = 'map_refresh');
DELETE FROM "__SCHEMA__".schedule_versions
WHERE schedule_id IN (SELECT id FROM "__SCHEMA__".schedules WHERE consumer_key = 'map_refresh');
DELETE FROM "__SCHEMA__".schedules WHERE consumer_key = 'map_refresh';

-- 3. 旧作业记录（explore_states.job_id 为 ON DELETE SET NULL，状态事实保留）
DELETE FROM "__SCHEMA__".map_job_commands;
DELETE FROM "__SCHEMA__".map_job_slices;
DELETE FROM "__SCHEMA__".map_jobs;

-- 4. 作业不再绑定单一安全进入路径；安全进入路径整体下线
ALTER TABLE "__SCHEMA__".map_jobs DROP COLUMN entry_id;
DROP TABLE "__SCHEMA__".map_safe_entries;

-- 5. 作业政策只保留总开关与分片时长
ALTER TABLE "__SCHEMA__".map_job_policies DROP COLUMN max_probe_pages;
ALTER TABLE "__SCHEMA__".map_job_policies DROP COLUMN max_probe_objects;
ALTER TABLE "__SCHEMA__".map_job_policies DROP COLUMN max_probe_actions;
ALTER TABLE "__SCHEMA__".map_job_policies DROP COLUMN max_probe_seconds;
ALTER TABLE "__SCHEMA__".map_job_policies DROP COLUMN max_refresh_pages;
ALTER TABLE "__SCHEMA__".map_job_policies DROP COLUMN max_refresh_objects;
ALTER TABLE "__SCHEMA__".map_job_policies DROP COLUMN max_refresh_actions;
ALTER TABLE "__SCHEMA__".map_job_policies DROP COLUMN max_refresh_seconds;
ALTER TABLE "__SCHEMA__".map_job_policies DROP COLUMN default_depth;
ALTER TABLE "__SCHEMA__".map_job_policies DROP COLUMN static_refresh_days;

-- 6. 探索权限下线
DELETE FROM "__SCHEMA__".console_role_permissions WHERE permission = 'map:explore';
