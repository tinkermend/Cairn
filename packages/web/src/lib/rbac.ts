import { hasPermission, type PermissionCode } from '@cairn/shared'
import type { AuthUser } from '@/stores/auth-store'

/**
 * 前端显隐用。没有主体即隐藏；真正的拒绝在 api。
 */
export function can(
  user: AuthUser | null,
  permission: PermissionCode
): boolean {
  if (!user) return false
  if (
    permission.startsWith('credential:') &&
    user.targetScopes &&
    user.targetScopePermissions
  ) {
    const scopesFor = (code: string) =>
      user.targetScopes!.filter((s) =>
        hasPermission(
          user.targetScopePermissions!.find((p) => p.roleId === s.roleId)
            ?.permissions ?? [],
          code
        )
      )
    const required = [
      'target:read',
      'credential:read',
      permission,
    ]
    const sets = required
      .map((code) => {
        const scopes = scopesFor(code)
        return scopes.some((s) => s.mode === 'all')
          ? null
          : new Set(
              scopes.flatMap((s) => (s.mode === 'selected' ? s.targetIds : []))
            )
      })
      .filter((s): s is Set<string> => s !== null)
    if (
      sets.length &&
      ![...sets[0]!].some((id) => sets.every((s) => s.has(id)))
    )
      return false
  }
  if (
    permission === 'credential:read' &&
    (!hasPermission(user.permissions, 'target:read') ||
      user.targetScopes?.every((scope) => scope.mode === 'none'))
  )
    return false
  return hasPermission(user.permissions, permission)
}

export function canAny(
  user: AuthUser | null,
  permissions: readonly PermissionCode[]
): boolean {
  return permissions.some((permission) => can(user, permission))
}

function targetScopeAllows(user: AuthUser, permission: PermissionCode, targetId?: string): boolean {
  if (!user.targetScopes || !user.targetScopePermissions) return false
  const relevant = user.targetScopes.filter((scope) => hasPermission(
    user.targetScopePermissions?.find((entry) => entry.roleId === scope.roleId)?.permissions ?? [],
    permission,
  ))
  return relevant.some((scope) => scope.mode === 'all' || targetId !== undefined && scope.mode === 'selected' && scope.targetIds.includes(targetId))
}

/** 仅用于界面动作显隐；服务端始终重新核验目标范围。 */
export function canOnTarget(user: AuthUser | null, permission: PermissionCode, targetId: string): boolean {
  return Boolean(user && can(user, 'target:read') && can(user, permission) &&
    targetScopeAllows(user, 'target:read', targetId) && targetScopeAllows(user, permission, targetId))
}

/** 创建新目标要求读取和写入都覆盖全部目标，与服务端约束一致。 */
export function canCreateTarget(user: AuthUser | null): boolean {
  return Boolean(user && can(user, 'target:read') && can(user, 'target:write') &&
    targetScopeAllows(user, 'target:read') && targetScopeAllows(user, 'target:write'))
}

export function canCreateTargetWithCredential(user: AuthUser | null): boolean {
  return Boolean(user && canCreateTarget(user) && can(user, 'credential:read') && can(user, 'credential:write') &&
    targetScopeAllows(user, 'credential:read') && targetScopeAllows(user, 'credential:write'))
}

export function visibleByPermission<
  T extends { permission?: PermissionCode; anyOf?: readonly PermissionCode[] },
>(items: T[], user: AuthUser | null): T[] {
  return items.filter((item) => {
    if (item.anyOf?.length) return canAny(user, item.anyOf)
    return !item.permission || can(user, item.permission)
  })
}

type NavGate = {
  title: string
  permission?: PermissionCode
  anyOf?: readonly PermissionCode[]
}

/** 侧栏与命令面板共用：父级无可见子项则整项去掉。 */
export function filterNavItems<
  T extends NavGate & { items?: readonly NavGate[] },
>(items: readonly T[], user: AuthUser | null): T[] {
  const visible: T[] = []
  for (const item of items) {
    if (
      (item.permission || item.anyOf?.length) &&
      !visibleByPermission([item], user).length
    ) {
      continue
    }
    if (item.items) {
      const children = visibleByPermission([...item.items], user)
      if (children.length > 0)
        visible.push({ ...item, items: children as T['items'] })
    } else if (visibleByPermission([item], user).length > 0) {
      visible.push(item)
    }
  }
  return visible
}
