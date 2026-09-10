import type { AccountStatus, RoleKind } from '@cairn/shared'

/**
 * 认证通过后挂到 req.account 的主体。
 *
 * AuthGuard 负责「你是谁」并装配本结构；PermissionsGuard 只读
 * permissions，不认角色名。认证功能落地前 AuthGuard 仍一律拒绝，
 * 测试里用替身 Guard 注入本对象。
 */
export interface RequestAccount {
  id: string
  displayName: string
  email: string | null
  status: AccountStatus
  roles: { id: string; key: string; name: string; kind: RoleKind }[]
  permissions: string[]
}

declare module 'express' {
  interface Request {
    account?: RequestAccount
  }
}
