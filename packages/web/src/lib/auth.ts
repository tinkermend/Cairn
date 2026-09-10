import type { AccountDto } from '@cairn/shared'
import type { AuthUser } from '@/stores/auth-store'

export function toAuthUser(account: AccountDto): AuthUser {
  return {
    id: account.id,
    displayName: account.displayName,
    email: account.email,
    roles: account.roles.map((role) => role.key),
    permissions: account.permissions,
  }
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
}
