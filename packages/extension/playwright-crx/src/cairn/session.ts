import {
  DEFAULT_ENVIRONMENT_ID,
  resolveApiEnvironment,
  type ApiEnvironment,
} from './config'

export type CairnAccount = {
  id: string
  displayName: string
  permissions: string[]
}

export type CairnSession = {
  environmentId: string
  environment: ApiEnvironment
  apiOrigin: string
  accessToken: string
  expiresAt: number | null
  account: CairnAccount | null
  targetId: string
}

const KEYS = [
  'cairnEnvironmentId',
  'cairnAccessToken',
  'cairnExpiresAt',
  'cairnAccount',
  'cairnTargetId',
] as const

function asAccount(value: unknown): CairnAccount | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.displayName !== 'string') return null
  return {
    id: record.id,
    displayName: record.displayName,
    permissions: Array.isArray(record.permissions)
      ? record.permissions.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

export async function loadCairnSession(): Promise<CairnSession> {
  const stored = await chrome.storage.local.get([...KEYS])
  const environment = resolveApiEnvironment(
    typeof stored.cairnEnvironmentId === 'string' ? stored.cairnEnvironmentId : DEFAULT_ENVIRONMENT_ID,
  )
  return {
    environmentId: environment.id,
    environment,
    apiOrigin: environment.origin,
    accessToken: typeof stored.cairnAccessToken === 'string' ? stored.cairnAccessToken : '',
    expiresAt: typeof stored.cairnExpiresAt === 'number' ? stored.cairnExpiresAt : null,
    account: asAccount(stored.cairnAccount),
    targetId: typeof stored.cairnTargetId === 'string' ? stored.cairnTargetId : '',
  }
}

/** 挂录制器会重载侧栏，选中的目标系统必须活过这次重载。 */
export async function saveTargetId(targetId: string): Promise<void> {
  await chrome.storage.local.set({ cairnTargetId: targetId })
}

export async function saveEnvironmentId(environmentId: string): Promise<ApiEnvironment> {
  const environment = resolveApiEnvironment(environmentId)
  await chrome.storage.local.set({ cairnEnvironmentId: environment.id })
  return environment
}

export async function saveAuth(input: {
  accessToken: string
  expiresIn: number
  account: CairnAccount
}): Promise<void> {
  await chrome.storage.local.set({
    cairnAccessToken: input.accessToken,
    cairnExpiresAt: Date.now() + input.expiresIn * 1000,
    cairnAccount: input.account,
  })
}

export async function clearAuth(): Promise<void> {
  await chrome.storage.local.remove([
    'cairnAccessToken',
    'cairnExpiresAt',
    'cairnAccount',
    'cairnTargetId',
  ])
}
