import {
  hasPermission,
  type PermissionCode,
} from '@cairn/shared'
import type { AuthUser } from '@/stores/auth-store'

/**
 * 前端显隐用。没有主体即隐藏；真正的拒绝在 api。
 */
export function can(user: AuthUser | null, permission: PermissionCode): boolean {
  if (!user) return false
  return hasPermission(user.permissions, permission)
}

export function visibleByPermission<T extends { permission?: PermissionCode }>(
  items: T[],
  user: AuthUser | null,
): T[] {
  return items.filter((item) => !item.permission || can(user, item.permission))
}
