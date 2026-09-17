import { beforeEach, expect, it, vi } from 'vitest'
import {
  appendSessionEvent,
  findActiveLeaseForSession,
  getSessionById,
  requestMaintenanceOperation,
} from '@cairn/db'
import { handleSessionAuthSignal } from './session-idle-observer'

vi.mock('@cairn/db', async (load) => ({
  ...(await load<typeof import('@cairn/db')>()),
  getSessionById: vi.fn(),
  findActiveLeaseForSession: vi.fn(),
  getPlatformConfig: vi.fn(async () => null),
  appendSessionEvent: vi.fn(async () => {}),
  requestMaintenanceOperation: vi.fn(async () => ({ operation: null, created: false })),
  loadCurrentAuthProfile: vi.fn(async () => null),
  loadTargetForExecution: vi.fn(async () => ({ loginUrl: 'https://example.com/login', entryUrl: 'https://example.com' })),
}))

const manager = {
  dbHandle: {},
  logger: { warn: vi.fn() },
  runAuth: new Map(),
  observeInRunAuth: vi.fn(async () => null),
} as any

beforeEach(() => {
  vi.clearAllMocks()
})

it('无 EXECUTION 租约时落账并排后台 VERIFY', async () => {
  vi.mocked(getSessionById).mockResolvedValue({
    id: 's',
    status: 'OPEN',
    targetId: 't',
    targetAccountId: 'a',
    generation: 1,
    authProbeIntervalSeconds: 900,
  } as any)
  vi.mocked(findActiveLeaseForSession).mockResolvedValue(null)
  await handleSessionAuthSignal(manager, 's', {
    kind: 'navigated_to_login',
    at: new Date().toISOString(),
    summary: '导航到登录页',
  })
  expect(appendSessionEvent).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ type: 'auth.signal_observed', sessionId: 's' }),
  )
  expect(requestMaintenanceOperation).toHaveBeenCalledWith(
    {},
    expect.objectContaining({
      origin: 'BACKGROUND',
      body: expect.objectContaining({ kind: 'VERIFY_AUTH' }),
    }),
  )
})

it('有 EXECUTION 租约时交给 D 门禁，不排后台 VERIFY', async () => {
  vi.mocked(getSessionById).mockResolvedValue({
    id: 's',
    status: 'OPEN',
    targetId: 't',
    targetAccountId: 'a',
    generation: 1,
  } as any)
  vi.mocked(findActiveLeaseForSession).mockResolvedValue({
    id: 'lease-1',
    sessionId: 's',
    sessionGeneration: 1,
    sessionFencingToken: 2,
    purpose: 'EXECUTION',
    ownerKind: 'RUN',
    runId: 'run-1',
    expiresAt: new Date(Date.now() + 30_000),
  } as any)
  await handleSessionAuthSignal(manager, 's', {
    kind: 'navigated_to_login',
    at: new Date().toISOString(),
    summary: '导航到登录页',
  })
  expect(appendSessionEvent).not.toHaveBeenCalled()
  expect(requestMaintenanceOperation).not.toHaveBeenCalled()
  expect(manager.runAuth.get('lease-1')).toMatchObject({ pendingSignal: true })
  expect(manager.observeInRunAuth).toHaveBeenCalledWith(
    expect.objectContaining({ leaseId: 'lease-1', purpose: 'EXECUTION', runId: 'run-1' }),
    'not_dispatched',
  )
})
