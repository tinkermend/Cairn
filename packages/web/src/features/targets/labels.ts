import type {
  AuthMethod,
  CaptchaMode,
  LoginLocator,
  LoginLocatorBy,
  TargetStatus,
} from '@cairn/shared'

export const AUTH_METHOD_LABELS: Record<AuthMethod, string> = {
  password: '账号密码',
  manual: '仅手工登录',
}

export const CAPTCHA_MODE_LABELS: Record<CaptchaMode, string> = {
  none: '无验证码',
  image: '图形验证码',
  slider: '滑动验证码',
  sms: '短信验证码',
  other: '其他',
}

export const TARGET_STATUS_LABELS: Record<TargetStatus, string> = {
  active: '启用',
  disabled: '停用',
}

export const LOGIN_LOCATOR_BY_LABELS: Record<LoginLocatorBy, string> = {
  id: '元素 id',
  name: 'name 属性',
  css: 'CSS 选择器',
}

export const LOGIN_FIELD_ROLE_LABELS = {
  username: '用户名框',
  password: '密码框',
  submit: '提交',
} as const

function formatLoginLocator(locator: LoginLocator): string {
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
