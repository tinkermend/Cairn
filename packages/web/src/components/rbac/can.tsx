import type { ReactNode } from 'react'
import { hasAllPermissions, type PermissionCode } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { can } from '@/lib/rbac'

type CanProps = {
  permission?: PermissionCode
  allOf?: readonly string[]
  children: ReactNode
  fallback?: ReactNode
}

/** 按权限显隐。没有登录主体时隐藏。真正的拒绝在 api。 */
export function Can({ permission, allOf, children, fallback = null }: CanProps) {
  const user = useAuthStore((s) => s.auth.user)
  const allowed = allOf
    ? Boolean(user && hasAllPermissions(user.permissions, allOf))
    : can(user, permission!)
  return allowed ? children : fallback
}
