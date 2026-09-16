import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserSessionManager } from './session-manager'

const mocks = vi.hoisted(() => ({
  getRun: vi.fn(),
  getSessionById: vi.fn(),
  findSessionByAuthHoldRun: vi.fn(),
}))

vi.mock('@cairn/db', async (original) => {
  const actual = await original<typeof import('@cairn/db')>()
  return {
    ...actual,
    getRun: mocks.getRun,
    getSessionById: mocks.getSessionById,
    getSessionOperation: vi.fn(async () => null),
    findActiveLeaseRow: vi.fn(async () => null),
    findSessionByAuthHoldRun: mocks.findSessionByAuthHoldRun,
  }
})

const sessionId = '00000000-0000-4000-8000-000000000021'
const runId = '00000000-0000-4000-8000-000000000022'
const actorId = '00000000-0000-4000-8000-000000000023'
const pageId = '00000000-0000-4000-8000-000000000024'
const leaseId = '00000000-0000-4000-8000-000000000025'

function observedManager() {
  const page = {
    isClosed: () => false,
    url: () => 'https://shop.example.com/app',
    viewportSize: () => ({ width: 1280, height: 720 }),
  }
  const live = {
    sessionId,
    autoInputClosed: false,
    inputAccepting: false,
    serial: Promise.resolve(),
    receipts: new Map(),
    lastSeq: 0,
    controlEpoch: 0,
    pages: new Map([[pageId, { pageId, runId, documentEpoch: 1, page, kind: 'run' }]]),
    currentPageIdByRun: new Map([[runId, pageId]]),
    currentPageIdByLease: new Map(),
    runPages: new Map(),
    screencasts: new Map(),
    screencastObservers: new Map(),
    allowedOrigins: ['https://shop.example.com'],
    handle: { basePage: page },
  }
  const session = {
    id: sessionId,
    generation: 1,
    ownerWorkerId: 'test-worker',
    ownerWorkerInstanceId: 'test-worker',
    authControlActorId: null,
    authControlExpiresAt: null,
    authControlEpoch: 0,
    authHoldRunId: null,
    authHoldExpiresAt: null,
    authHoldWorkerId: null,
  }
  const manager = Object.create(BrowserSessionManager.prototype) as BrowserSessionManager
  Object.assign(manager, {
    dbHandle: {},
    workerInstanceId: 'test-worker',
    options: { workerId: 'test-worker' },
    lives: new Map([[sessionId, live]]),
    leaseToRun: new Map([[leaseId, runId]]),
    leaseToSession: new Map([[leaseId, sessionId]]),
    sessionOwnedHere: () => true,
    liveAuthHold: () => null,
  })
  return { manager, session }
}

describe('续跑后观察会话', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('领取后 placement 不含 sessionId 仍报告可观察画面', async () => {
    const { manager, session } = observedManager()
    mocks.findSessionByAuthHoldRun.mockResolvedValue(null)
    mocks.getRun.mockResolvedValue({
      id: runId,
      status: 'RUNNING',
      placement: { state: 'claimed', sessionId: null, ownerWorkerId: null, sessionStatus: null },
    })
    mocks.getSessionById.mockResolvedValue(session)
    const meta = await manager.describeRunBrowser({ runId, actorId })
    expect(meta.framesAvailable).toBe(true)
    expect(meta.sessionId).toBe(sessionId)
    expect(meta.currentPage?.currentExecution).toBe(true)
  })

  it('续跑空隙没有租约映射时仍能靠页面归属找到会话', async () => {
    const { manager, session } = observedManager()
    Object.assign(manager, {
      leaseToRun: new Map(),
      leaseToSession: new Map(),
    })
    mocks.findSessionByAuthHoldRun.mockResolvedValue(null)
    mocks.getRun.mockResolvedValue({
      id: runId,
      status: 'RECOVERING',
      placement: { state: 'claimable', sessionId: null, ownerWorkerId: null, sessionStatus: null },
    })
    mocks.getSessionById.mockResolvedValue(session)
    const meta = await manager.describeRunBrowser({ runId, actorId })
    expect(meta.framesAvailable).toBe(true)
    expect(meta.sessionId).toBe(sessionId)
    expect(meta.runStatus).toBe('RECOVERING')
  })
})
