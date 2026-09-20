import type {
  CredentialMaintenanceStatus,
  CredentialOwnerStatus,
  CredentialSessionAuthState,
  CredentialSessionBrowserState,
  CredentialType,
  CredentialUsageKind,
  CredentialVerificationStatus,
} from '@cairn/shared'

export const CREDENTIAL_TYPE_LABELS: Record<CredentialType, string> = {
  target_password: '目标登录密码',
  model_key: '模型服务 Key',
  alert_webhook: '告警 Webhook',
  service_key: '开放服务 Key',
}

export const MAINTENANCE_LABELS: Record<CredentialMaintenanceStatus, string> = {
  unknown: '未设置有效期',
  not_due: '未到期',
  approaching: '即将到期',
  due: '已到期',
  permanent: '永久',
}

export const OWNER_LABELS: Record<CredentialOwnerStatus, string> = {
  assigned: '已指定',
  unclaimed: '待认领',
  needs_handover: '需交接',
}

export const VERIFICATION_LABELS: Record<CredentialVerificationStatus, string> =
  {
    not_applicable: '不适用',
    pending: '待核验',
    verified: '已核验',
    failed: '核验失败',
    inconclusive: '结果不明',
  }

export const SESSION_BROWSER_LABELS: Record<
  CredentialSessionBrowserState,
  string
> = {
  unprepared: '尚未启动浏览器',
  online: '在线',
  lost: '已失联',
  closed: '已关闭',
  unknown: '状态未知',
  not_applicable: '不适用',
  forbidden: '无权查看',
  unavailable: '暂时不可用',
}

export const SESSION_AUTH_LABELS: Record<CredentialSessionAuthState, string> = {
  verified: '登录已核验',
  pending: '登录待核验',
  expired: '登录已失效',
  manual_required: '需人工登录',
  unknown: '尚未检查登录',
  not_applicable: '不适用',
  forbidden: '无权查看',
  unavailable: '暂时不可用',
}

export const USAGE_KIND_LABELS: Record<CredentialUsageKind, string> = {
  confirmed: '已确认',
  possible: '可能相关',
  active: '当前使用',
}

export const USAGE_RESOURCE_LABELS: Record<
  | 'run'
  | 'schedule'
  | 'session'
  | 'target_account'
  | 'model_config'
  | 'alert_channel'
  | 'service',
  string
> = {
  run: '运行',
  schedule: '调度',
  session: '会话',
  target_account: '目标账号',
  model_config: '模型配置',
  alert_channel: '告警渠道',
  service: '开放服务',
}

export function credentialSessionLabel(session: {
  browser: CredentialSessionBrowserState
  auth: CredentialSessionAuthState
}) {
  if (session.browser === 'not_applicable') return '—'
  return `${SESSION_BROWSER_LABELS[session.browser]} · ${SESSION_AUTH_LABELS[session.auth]}`
}
