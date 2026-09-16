import type {
  AiCommand,
  AiExecutionConfig,
  AiResult,
  AuthRecoveryOutcome,
  AuthObservation,
  AuthSignal,
  BrowserCommand,
  BrowserCommandEvidence,
  BrowserCommandResult,
  ExecutionError,
  MapCapturePolicy,
  MapConditionSnapshot,
  MapObservation,
  MapObservationPhase,
  MapRunSourceType,
  PageRef,
  RunGrant,
  RunSnapshot,
  ScreenshotPointer,
  SessionErrorCode,
  SessionGrant,
} from '@cairn/shared'

/**
 * acquire 失败走返回值里的码，不抛成无 Schema 的 Error。
 * 真正的进程 / DB 故障仍然抛。
 */
export type SessionAcquireOutcome =
  | { ok: true; grant: SessionGrant }
  | { ok: false; code: SessionErrorCode; message: string; waitingForAuth?: boolean }

/**
 * Engine 只认这个端口，不认识 playwright / BrowserSessionManager。
 * acquire 必须带 RunGrant：会话租约的 run_fencing_token 只从执行租约取。
 */
export type BrowserPort = {
  acquire(run: RunSnapshot, grant: RunGrant, signal?: AbortSignal): Promise<SessionAcquireOutcome>
  release(grant: SessionGrant, reason: string): Promise<void>
  invalidate?(grant: SessionGrant, reason: string): Promise<void>
  execute(
    grant: SessionGrant,
    command: BrowserCommand,
    signal?: AbortSignal,
    evidence?: BrowserCommandEvidence,
  ): Promise<BrowserCommandResult>
  /**
   * Read-only runtime facts used only to decide map applicability.  Failure is
   * represented by omitted fields, never by guessing from an account id.
   */
  sampleMapConditions?(grant: SessionGrant, signal?: AbortSignal): Promise<{
    locale?: string
    viewport?: MapConditionSnapshot['viewport']
    pageFrameObserved: boolean
  }>
  describeHold?(runId: string): Promise<{ pageRef?: PageRef; url?: string; authSignal?: AuthSignal; authObservation?: AuthObservation; contextRecoverable?: boolean } | undefined>
  recoverAuth?(
    grant: SessionGrant,
    input: { kind: 'auto' | 'manual'; runGrant: RunGrant; snapshot: RunSnapshot; resuming?: boolean; signal?: AbortSignal },
  ): Promise<AuthRecoveryOutcome>
}

export type AiPort = {
  execute(
    grant: SessionGrant,
    command: AiCommand,
    signal: AbortSignal,
    evidence: BrowserCommandEvidence & {
      grant: RunGrant
      maxCalls: number
      model?: string
      config: AiExecutionConfig
    },
  ): Promise<
    AiResult & {
      screenshot?: ScreenshotPointer
      trace?: ScreenshotPointer
      /** 端口能判定时给出结构化错误（如丢租），执行器原样使用，不再笼统记成 AI_EXECUTION_FAILED。 */
      error?: ExecutionError
    }
  >
}

export const AI_PORT = Symbol('AI_PORT')

export const BROWSER_PORT = Symbol('BROWSER_PORT')

export type PassiveMapCaptureInput = {
  grant: RunGrant
  sessionGrant?: SessionGrant
  runId: string
  stepRunId: string
  attemptId: string
  phase: Extract<MapObservationPhase, 'before_action' | 'after_action'>
  targetId: string
  policy: MapCapturePolicy
  sourceType: MapRunSourceType
  condition: MapConditionSnapshot
  remainingStepMs: number
  runBudgetUsedMs: number
  signal?: AbortSignal
  stepType: string
  allowedOrigins?: string[]
}

export type PassiveMapCaptureResult =
  | { observation: MapObservation }
  | { gap: MapObservation }

/**
 * 只读被动采集。不得点击、高亮、滚动或注入目标函数。
 * Engine 只认这个端口，不认识 Playwright / SessionManager。
 */
export type PassiveMapObservationPort = {
  capture(input: PassiveMapCaptureInput): Promise<PassiveMapCaptureResult>
}

export const MAP_OBSERVATION_PORT = Symbol('MAP_OBSERVATION_PORT')
