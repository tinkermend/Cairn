export type LoginSubmitOutcome = 'authenticated' | 'captcha_failed' | 'credential_failed' | 'ambiguous'

const CAPTCHA_FAILED =
  /验证码(错误|不正确|过期|失效|有误)|请输入.*验证码|至少\s*\d+\s*位.*验证码|captcha\s*(error|incorrect|invalid|expired)/i
const CREDENTIAL_FAILED =
  /用户名或密码|账号或密码|帐户或密码|密码错误|用户不存在|账号不存在|账户不存在|incorrect password|invalid credentials|wrong password/i

export function classifyLoginSubmitText(text: string): Exclude<LoginSubmitOutcome, 'authenticated' | 'ambiguous'> | null {
  const sample = text.trim()
  if (!sample) return null
  if (CREDENTIAL_FAILED.test(sample)) return 'credential_failed'
  if (CAPTCHA_FAILED.test(sample)) return 'captcha_failed'
  return null
}

export function shouldRetryLoginSubmit(outcome: LoginSubmitOutcome, challengeStillPresent = false): boolean {
  if (outcome === 'credential_failed' || outcome === 'ambiguous') return false
  return outcome === 'captcha_failed' || challengeStillPresent
}

export type LoginAttemptResult = {
  authenticated: boolean
  submit: LoginSubmitOutcome | 'unsolved' | 'not_attempted'
}

export function shouldContinueCaptchaRetry(result: LoginAttemptResult): boolean {
  if (result.authenticated) return false
  return result.submit === 'captcha_failed' || result.submit === 'unsolved'
}
