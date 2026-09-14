import type { AuthUser } from '@/stores/auth-store'
import { can } from '@/lib/rbac'

export const AUDIT_PANES = ['operations', 'logins'] as const
export type AuditPane = (typeof AUDIT_PANES)[number]

export const AUDIT_PANE_COPY: Record<AuditPane, { title: string; description: string }> = {
  operations: {
    title: '操作记录',
    description: '谁在控制台改了账号、权限、目标系统、场景或运行。',
  },
  logins: {
    title: '登录记录',
    description: '控制台与扩展的登录尝试，包括来源地址和成败原因。',
  },
}

export function visibleAuditPanes(user: AuthUser | null): AuditPane[] {
  const panes: AuditPane[] = []
  if (can(user, 'audit:read')) panes.push('operations')
  if (can(user, 'audit:login')) panes.push('logins')
  return panes
}
