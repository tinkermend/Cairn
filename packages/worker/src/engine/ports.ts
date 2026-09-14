import type {
  AiCommand,
  AiExecutionConfig,
  AiResult,
  BrowserCommand,
  BrowserCommandEvidence,
  BrowserCommandResult,
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
  ): Promise<AiResult & { screenshot?: ScreenshotPointer; trace?: ScreenshotPointer }>
}

export const AI_PORT = Symbol('AI_PORT')

export const BROWSER_PORT = Symbol('BROWSER_PORT')
