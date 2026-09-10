import { type PermissionCode } from '@cairn/shared'
import { can } from '@/lib/rbac'
import { useAuthStore } from '@/stores/auth-store'

export function useCan(permission: PermissionCode): boolean {
  const user = useAuthStore((s) => s.auth.user)
  return can(user, permission)
}
