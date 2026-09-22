-- 0094 的 MySQL 等价增量：同账号多独立会话。丢掉 live_slot「是否活着」语义，露出 account_slot。

ALTER TABLE target_accounts
  ADD COLUMN max_concurrent_sessions INT NOT NULL DEFAULT 1;

ALTER TABLE target_accounts
  ADD CONSTRAINT target_accounts_max_concurrent_sessions_range
  CHECK (max_concurrent_sessions BETWEEN 1 AND 16);

ALTER TABLE browser_sessions
  ADD COLUMN account_slot INT NOT NULL DEFAULT 1;

ALTER TABLE browser_sessions
  ADD CONSTRAINT browser_sessions_account_slot_range
  CHECK (account_slot BETWEEN 1 AND 16);

ALTER TABLE browser_sessions
  DROP INDEX browser_sessions_key_live_idx;

ALTER TABLE browser_sessions
  DROP COLUMN live_slot;

ALTER TABLE browser_sessions
  ADD COLUMN live_account_slot INT GENERATED ALWAYS AS (
    CASE WHEN status IN ('CREATING', 'OPEN', 'CLOSING', 'LOST') THEN account_slot ELSE NULL END
  ) STORED;

CREATE UNIQUE INDEX browser_sessions_key_live_idx
  ON browser_sessions (target_id, target_account_id, live_account_slot);

ALTER TABLE session_profiles
  ADD COLUMN account_slot INT NOT NULL DEFAULT 1;

ALTER TABLE session_profiles
  ADD CONSTRAINT session_profiles_account_slot_range
  CHECK (account_slot BETWEEN 1 AND 16);

ALTER TABLE session_profiles
  DROP PRIMARY KEY;

ALTER TABLE session_profiles
  ADD PRIMARY KEY (target_id, target_account_id, account_slot);

ALTER TABLE session_retention_intents
  ADD COLUMN session_id VARCHAR(36) NULL;

UPDATE session_retention_intents intent
JOIN (
  SELECT s.id, s.target_id, s.target_account_id
  FROM browser_sessions s
  INNER JOIN (
    SELECT target_id, target_account_id, MIN(account_slot) AS account_slot
    FROM browser_sessions
    WHERE status IN ('CREATING', 'OPEN', 'CLOSING', 'LOST')
    GROUP BY target_id, target_account_id
    HAVING COUNT(*) = 1
  ) one
    ON one.target_id = s.target_id
   AND one.target_account_id = s.target_account_id
   AND one.account_slot = s.account_slot
  WHERE s.status IN ('CREATING', 'OPEN', 'CLOSING', 'LOST')
) live
  ON intent.target_id = live.target_id
 AND intent.target_account_id = live.target_account_id
SET intent.session_id = live.id
WHERE intent.session_id IS NULL;

DELETE FROM session_retention_intents
WHERE session_id IS NULL;

ALTER TABLE session_retention_intents
  DROP INDEX session_retention_intents_key_idx;

CREATE UNIQUE INDEX session_retention_intents_session_idx
  ON session_retention_intents (session_id);

ALTER TABLE target_account_auth_budget
  ADD COLUMN login_in_flight TINYINT(1) NOT NULL DEFAULT 0;
