import { hasPermission } from '@cairn/shared'

export type ConsoleAuthSnapshot = {
  accessToken: string
  account: { id: string; displayName: string; permissions: readonly string[] } | null
}

export function canAttachRecorder(session: ConsoleAuthSnapshot): boolean {
  return Boolean(session.accessToken && session.account)
}

export function canReadTargets(permissions: readonly string[]): boolean {
  return hasPermission(permissions, 'target:read')
}

export function canUploadRecording(permissions: readonly string[]): boolean {
  return hasPermission(permissions, 'workflow:write') && hasPermission(permissions, 'target:read')
}
