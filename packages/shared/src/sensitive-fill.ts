/** 填写 / 指认共用的敏感定位词。独立文件避免 recording ↔ authoring 循环依赖。 */
export const SENSITIVE_LOCATOR = /password|passwd|secret|token|otp|\bpin\b|密码|口令|验证码/i

export const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
])

export function isSensitiveLocatorHay(hay: string): boolean {
  return SENSITIVE_LOCATOR.test(hay)
}
