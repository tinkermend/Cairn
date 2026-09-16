import type { AccountSessionStatus, SessionOverviewFilter } from '@cairn/shared'

export const ACCOUNT_SESSION_STATUS_LABELS: Record<AccountSessionStatus, string> = {
  unprepared: '未准备',
  ready: '就绪',
  needs_check: '待检查',
  needs_login: '需要登录',
  identity_mismatch: '账号不符',
  maintenance: '维护中',
  executing: '执行中',
  lost: '失联',
}

export const ACCOUNT_SESSION_STATUS_TONE: Record<
  AccountSessionStatus,
  'neutral' | 'success' | 'warning' | 'info'
> = {
  unprepared: 'neutral',
  ready: 'success',
  needs_check: 'info',
  needs_login: 'warning',
  identity_mismatch: 'warning',
  maintenance: 'info',
  executing: 'info',
  lost: 'warning',
}

export const SESSION_FILTER_LABELS: Record<SessionOverviewFilter | 'all', string> = {
  all: '全部',
  available: '可用',
  needs_check: '待检查',
  needs_login: '需要登录',
  identity_mismatch: '账号不符',
  maintenance: '维护中',
  executing: '执行中',
  lost: '失联',
  unprepared: '未准备',
  retained: '保留中',
}

export const PRIMARY_ACTION_LABELS: Record<string, string> = {
  PREPARE: '准备会话',
  VERIFY_AUTH: '检查登录',
  LOGIN: '登录',
  RENEW_AUTH: '续登',
  view: '查看进度',
  dispose: '处置失联',
}

export const OPERATION_KIND_LABELS: Record<string, string> = {
  VALIDATE_AUTH_PROFILE: '验收认证规则',
  PREPARE: '准备会话',
  VERIFY_AUTH: '检查登录',
  LOGIN: '登录',
  RENEW_AUTH: '续登',
  REFRESH_LOGIN_PAGE: '刷新登录页',
  CLOSE: '关闭会话',
  RESTART: '重启会话',
  RESET_PROFILE: '清除登录数据',
}

export function sessionAuthLabel(authState?: string | null, identityState?: string | null) {
  const auth: Record<string, string> = { AUTHENTICATED: '登录已核验', EXPIRED: '登录已失效', UNKNOWN: '登录待核验' }
  const identity: Record<string, string> = { MATCH: '账号一致', MISMATCH: '账号不符', UNVERIFIED: '身份未核验' }
  return [auth[authState ?? 'UNKNOWN'] ?? '登录待核验', identityState ? identity[identityState] : null].filter(Boolean).join(' · ')
}

export function sessionEventLabel(type: string, payload: Record<string, unknown>) {
  const labels: Record<string, string> = {
    'operation.requested': '已提交', 'operation.claimed': '开始执行',
    'operation.waiting_for_auth': '等待人工认证', 'operation.finished': '已结束', 'operation.cancelled': '已取消',
    'retention.set': '已设置保留', 'retention.extended': '已延长保留', 'retention.cleared': '已取消保留',
    'session.closed': '会话已关闭', 'session.restarted': '会话已重启', 'session.lost': '会话已失联',
    'profile.reset': '登录数据已清除', 'auth.control_changed': '认证控制权已变更',
    'auth.attempt_started': '开始登录', 'auth.verified': '登录核验完成', 'auth.unknown': '登录状态待确认',
  }
  const status: Record<string, string> = { SUCCEEDED: '已完成', FAILED: '失败', CANCELLED: '已取消' }
  const label = type === 'operation.finished' ? status[String(payload.status)] ?? labels[type] : labels[type]
  const kind = OPERATION_KIND_LABELS[String(payload.kind)]
  return [kind, label ?? '会话状态已更新'].filter(Boolean).join(' · ')
}
