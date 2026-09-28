import type {
  AccountUsage,
  AuthCapabilityTier,
  AuthMethod,
  LoginLocator,
  LoginLocatorBy,
} from '@cairn/shared'
export { AUTH_METHOD_LABELS, CAPTCHA_MODE_LABELS, TARGET_STATUS_LABELS } from '@cairn/shared'

export const ACCOUNT_USAGE_LABELS: Record<AccountUsage, string> = {
  business: '业务运行',
  map: '仅知识采集（不能跑业务）',
  both: '业务运行，并采集知识',
}

export const LOGIN_LOCATOR_BY_LABELS: Record<LoginLocatorBy, string> = {
  id: '元素 id',
  name: 'name 属性',
  css: 'CSS 选择器',
}

export const AUTH_CAPABILITY_LABELS: Record<AuthCapabilityTier, string> = {
  IDENTITY_VERIFIED: '已启用登录态检测 · 可核验身份',
  LOGIN_VERIFIED: '已启用登录态检测',
  LEGACY: '未配置登录态检测',
}

export const LOGIN_FIELD_ROLE_LABELS = {
  username: '用户名框',
  password: '密码框',
  submit: '提交',
  captchaImage: '验证码图片',
  captchaInput: '验证码输入框',
  captchaKnob: '滑块手柄',
  captchaBg: '滑块背景或轨道',
} as const

export function formatLoginLocator(locator: LoginLocator): string {
  return `${LOGIN_LOCATOR_BY_LABELS[locator.by]}：${locator.value}`
}

export function formatLoginFieldState(
  authMethod: AuthMethod,
  locator: LoginLocator | undefined,
): string {
  if (locator) return formatLoginLocator(locator)
  if (authMethod === 'manual') return '仅手工登录时定位仅作备用'
  return '未指定，运行时按平台常见字段猜测'
}
