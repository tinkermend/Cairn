import { describe, expect, it, vi } from 'vitest'
import { DomainError, hashAuthControlToken } from '@cairn/db'
import { BrowserSessionManager } from './session-manager'

const state = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  run: { status: 'WAITING_FOR_AUTH', snapshot: {} },
}))

vi.mock('@cairn/db', async (original) => {
  const actual = await original<typeof import('@cairn/db')>()
  return {
    ...actual,
    heartbeatAuthControl: async () => ({
      epoch: Number(state.session.authControlEpoch ?? 1),
      expiresAt: new Date(Date.now() + 30_000),
    }),
    getSessionById: async () => state.session,
    getRun: async () => state.run,
    // 人工续跑要碰页面，生产路径要求先拿到 AUTH_WAIT 租约再装占用（不变量 2）。
    findAuthWaitLeaseForRun: async () => ({
      id: '00000000-0000-4000-8000-000000000005',
      sessionId: '00000000-0000-4000-8000-000000000001',
      sessionGeneration: 1,
      sessionFencingToken: 1,
      expiresAt: new Date(Date.now() + 30_000),
      purpose: 'AUTH_WAIT',
      ownerKind: 'RUN',
      runId: '00000000-0000-4000-8000-000000000002',
      operationId: null,
    }),
    getWorkerById: async () => ({
      id: 'test-worker',
      instanceId: 'test-worker',
      status: 'READY',
      heartbeatExpiresAt: new Date(Date.now() + 30_000),
    }),
  }
})

const sessionId = '00000000-0000-4000-8000-000000000001'
const runId = '00000000-0000-4000-8000-000000000002'
const actorId = '00000000-0000-4000-8000-000000000003'
const pageId = '00000000-0000-4000-8000-000000000004'
const token = 'review-token-old'

function rig(options?: { holdSerial?: boolean }) {
  let release!: () => void
  const insertText = vi.fn(async () => undefined)
  const page = {
    isClosed: () => false,
    viewportSize: () => ({ width: 1280, height: 720 }),
    url: () => 'https://shop.example.com/login',
    locator: () => ({ count: async () => 0 }),
    keyboard: { insertText },
  }
  const session = {
    id: sessionId,
    generation: 1,
    ownerWorkerId: 'test-worker',
    ownerWorkerInstanceId: 'test-worker',
    authControlEpoch: 1,
    authControlActorId: actorId,
    authControlTokenHash: hashAuthControlToken(token),
    authControlExpiresAt: new Date(Date.now() + 30_000),
  }
  state.session = { ...session }
  state.run = { status: 'WAITING_FOR_AUTH', snapshot: {} }
  const live = {
    sessionId,
    autoInputClosed: true,
    inputAccepting: true,
    serial: options?.holdSerial
      ? new Promise<void>((resolve) => {
          release = resolve
        })
      : Promise.resolve(),
    receipts: new Map(),
    lastSeq: 0,
    controlEpoch: 1,
    pages: new Map([[pageId, { pageId, runId, documentEpoch: 1, page }]]),
    currentPageIdByRun: new Map([[runId, pageId]]),
    currentPageIdByLease: new Map(),
    runPages: new Map(),
    handle: { basePage: page },
    screencasts: new Map(),
    screencastObservers: new Map(),
    allowedOrigins: ['https://shop.example.com'],
  }
  const manager = Object.create(BrowserSessionManager.prototype) as BrowserSessionManager
  Object.assign(manager, {
    dbHandle: {},
    workerInstanceId: 'test-worker',
    options: { workerId: 'test-worker' },
    requireLiveAuthSession: async () => ({ session: state.session, live, run: state.run }),
    loadTargetAuth: async () => ({
      entryUrl: 'https://shop.example.com/',
      loginUrl: 'https://shop.example.com/login',
    }),
  })
  const command = {
    type: 'insert_text' as const,
    text: 'REVIEW_TEST_ONLY',
    commandId: '00000000-0000-4000-8000-000000000005',
    seq: 1,
    pageRef: { sessionId, sessionGeneration: 1, pageId, documentEpoch: 1 },
    frameId: 'test-frame',
    viewport: { width: 1280, height: 720 },
  }
  return { manager, live, command, release, insertText }
}

describe('认证输入 fencing', () => {
  it('并发重复命令只执行一次', async () => {
    const r = rig()
    const input = { runId, actorId, token, command: r.command }
    const [first, second] = await Promise.all([
      r.manager.inputRunAuthControl(input),
      r.manager.inputRunAuthControl(input),
    ])
    expect(r.insertText).toHaveBeenCalledTimes(1)
    expect([first.status, second.status]).toContain('accepted')
    expect([first.status, second.status]).toContain('duplicate')
  })

  it('排队中的旧控制代次在同 actor 重新取得后被拒绝', async () => {
    const r = rig({ holdSerial: true })
    const pending = r.manager.inputRunAuthControl({ runId, actorId, token, command: r.command })
    await new Promise((resolve) => setTimeout(resolve, 0))
    state.session.authControlEpoch = 2
    r.release()
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_CONTROL_INVALID' } satisfies Partial<DomainError>)
    expect(r.insertText).not.toHaveBeenCalled()
  })

  it('文档代次变化后的迟到点击不得执行', async () => {
    const r = rig({ holdSerial: true })
    const pending = r.manager.inputRunAuthControl({ runId, actorId, token, command: r.command })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const entry = r.live.pages.get(pageId)
    if (entry) entry.documentEpoch = 2
    r.release()
    await expect(pending).rejects.toMatchObject({ code: 'PAGE_STALE' })
    expect(r.insertText).not.toHaveBeenCalled()
  })

  it('开始续跑后立即关闭输入门，迟到命令不得再入队', async () => {
    const r = rig({ holdSerial: true })
    const resume = r.manager.resumeRunAuth({ runId, actor: { id: actorId }, token })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(r.live.inputAccepting).toBe(false)
    await expect(
      r.manager.inputRunAuthControl({ runId, actorId, token, command: r.command }),
    ).rejects.toMatchObject({ code: 'AUTH_INPUT_REJECTED' })
    r.release()
    await expect(resume).rejects.toMatchObject({ code: 'AUTH_NOT_VERIFIED' })
    expect(r.live.inputAccepting).toBe(true)
    expect(r.insertText).not.toHaveBeenCalled()
  })
})
