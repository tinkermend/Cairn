-- 0094：同账号多独立会话。账号上限、会话 slot、按 slot 的 Profile 与按会话的保留意图。

ALTER TABLE "__SCHEMA__".target_accounts
  ADD COLUMN IF NOT EXISTS max_concurrent_sessions INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'target_accounts_max_concurrent_sessions_range'
      AND conrelid = '"__SCHEMA__".target_accounts'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".target_accounts
      ADD CONSTRAINT target_accounts_max_concurrent_sessions_range
      CHECK (max_concurrent_sessions BETWEEN 1 AND 16);
  END IF;
END $$;

ALTER TABLE "__SCHEMA__".browser_sessions
  ADD COLUMN IF NOT EXISTS account_slot INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'browser_sessions_account_slot_range'
      AND conrelid = '"__SCHEMA__".browser_sessions'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".browser_sessions
      ADD CONSTRAINT browser_sessions_account_slot_range
      CHECK (account_slot BETWEEN 1 AND 16);
  END IF;
END $$;

DROP INDEX IF EXISTS "__SCHEMA__".browser_sessions_key_live_idx;

CREATE UNIQUE INDEX IF NOT EXISTS browser_sessions_key_live_idx
  ON "__SCHEMA__".browser_sessions (target_id, target_account_id, account_slot)
  WHERE status IN ('CREATING', 'OPEN', 'CLOSING', 'LOST');

ALTER TABLE "__SCHEMA__".session_profiles
  ADD COLUMN IF NOT EXISTS account_slot INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_profiles_account_slot_range'
      AND conrelid = '"__SCHEMA__".session_profiles'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".session_profiles
      ADD CONSTRAINT session_profiles_account_slot_range
      CHECK (account_slot BETWEEN 1 AND 16);
  END IF;
END $$;

ALTER TABLE "__SCHEMA__".session_profiles
  DROP CONSTRAINT IF EXISTS session_profiles_pkey;

ALTER TABLE "__SCHEMA__".session_profiles
  ADD CONSTRAINT session_profiles_pkey PRIMARY KEY (target_id, target_account_id, account_slot);

ALTER TABLE "__SCHEMA__".session_retention_intents
  ADD COLUMN IF NOT EXISTS session_id UUID;

UPDATE "__SCHEMA__".session_retention_intents intent
SET session_id = live.id
FROM (
  SELECT DISTINCT ON (target_id, target_account_id)
    id, target_id, target_account_id
  FROM "__SCHEMA__".browser_sessions
  WHERE status IN ('CREATING', 'OPEN', 'CLOSING', 'LOST')
  ORDER BY target_id, target_account_id, account_slot, created_at, id
) live
WHERE intent.session_id IS NULL
  AND intent.target_id = live.target_id
  AND intent.target_account_id = live.target_account_id;

DELETE FROM "__SCHEMA__".session_retention_intents
WHERE session_id IS NULL;

DROP INDEX IF EXISTS "__SCHEMA__".session_retention_intents_key_idx;

CREATE UNIQUE INDEX IF NOT EXISTS session_retention_intents_session_idx
  ON "__SCHEMA__".session_retention_intents (session_id);

ALTER TABLE "__SCHEMA__".target_account_auth_budget
  ADD COLUMN IF NOT EXISTS login_in_flight BOOLEAN NOT NULL DEFAULT FALSE;
