import type { ReactNode } from 'react'
import type { PermissionCode } from '@cairn/shared'
import { useCan } from '@/hooks/use-permissions'

type CanProps = {
  permission: PermissionCode
  children: ReactNode
  fallback?: ReactNode
}

/** 按权限显隐。没有登录主体时隐藏。真正的拒绝在 api。 */
export function Can({ permission, children, fallback = null }: CanProps) {
  const allowed = useCan(permission)
  return allowed ? children : fallback
}
