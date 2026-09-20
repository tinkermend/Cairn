-- 0071_target_captcha_locator：Target 级显式验证码定位器配置（图形/滑块）。
--
-- 只存运营方显式配置的定位器；未配置时运行期继续走内置指纹库自动探测（见
-- packages/worker/src/browser/captcha/challenge-dispatcher.ts）。
-- null 与未配置同义，语义与 login_fields 一致。
--
-- 全文幂等：重复执行不产生副作用。

ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN IF NOT EXISTS captcha JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'targets_captcha_object'
      AND conrelid = '"__SCHEMA__".targets'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".targets
      ADD CONSTRAINT targets_captcha_object
      CHECK (captcha IS NULL OR jsonb_typeof(captcha) = 'object');
  END IF;
END $$;
