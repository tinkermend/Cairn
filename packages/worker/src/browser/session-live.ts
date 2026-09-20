import type { CompiledAccessScope, AuthControlInputReceipt, ObserveGrant, RunSnapshot, SessionErrorCode, SessionGrant } from '@cairn/shared'
import type { BrowserHandle, openRunPage } from './runtime.js'
import type { ManagedPageEntry } from './page-identity.js'
import type { ScreencastHandle } from './screencast.js'
import type { BrowserSessionManager } from './session-manager.js'

export type BrowserSessionManagerOptions = {
  workerId: string
  profileRoot: string
  headless: boolean
  maxSessions: number
  executablePath?: string
  defaultLeaseTtlSeconds: number
  /** 仅兼容旧测试夹具；缺字段的历史快照回落代码默认，不读当前进程 env。 */
  defaultAuthWaitSeconds: number
  heartbeatMs: number
  workerInstanceId?: string
}

export type SessionAcquireResult =
  | { ok: true; grant: SessionGrant }
  | { ok: false; code: SessionErrorCode; message: string; waitingForAuth?: boolean }

export class SessionLeaseError extends Error {
  readonly code: SessionErrorCode

  constructor(code: SessionErrorCode, message: string) {
    super(message)
    this.name = 'SessionLeaseError'
    this.code = code
  }
}

export type LiveHandle = {
  handle: BrowserHandle
  sessionId: string
  generation: number
  runPageIds: Set<string>
  runPages: Map<string, Awaited<ReturnType<typeof openRunPage>>>
  lastPage?: Awaited<ReturnType<typeof openRunPage>>
  pages: Map<string, ManagedPageEntry>
  currentPageIdByLease: Map<string, string>
  currentPageIdByRun: Map<string, string>
  autoInputClosed: boolean
  inputAccepting: boolean
  serial: Promise<void>
  allowedOrigins: string[]
  accessScope?: CompiledAccessScope
  receipts: Map<string, AuthControlInputReceipt>
  lastSeq: number
  controlEpoch: number
  screencasts: Map<string, ScreencastHandle>
  screencastObservers: Map<string, number>
  authObserver?: { dispose: () => void }
}

export type RunAuthState = {
  snapshot?: RunSnapshot
  observer?: { inspect: () => Promise<void> }
  pendingSignal?: boolean
  transient?: boolean
}

export type ObserveGrantEntry = { grant: ObserveGrant; expiresAt: number }

/** 进程内唯一状态源就是经理类本身，禁止复制 Map。 */
export type SessionManagerContext = BrowserSessionManager

export function emptyLive(handle: BrowserHandle, sessionId: string, generation = 1): LiveHandle {
  return {
    handle,
    sessionId,
    generation,
    runPageIds: new Set(),
    runPages: new Map(),
    pages: new Map(),
    currentPageIdByLease: new Map(),
    currentPageIdByRun: new Map(),
    autoInputClosed: false,
    inputAccepting: false,
    serial: Promise.resolve(),
    allowedOrigins: [],
    receipts: new Map(),
    lastSeq: 0,
    controlEpoch: 0,
    screencasts: new Map(),
    screencastObservers: new Map(),
  }
}
