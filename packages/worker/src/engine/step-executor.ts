import type {
  ExecutionError,
  JsonValue,
  ResolverDiagnostics,
  ScreenshotPointer,
  SessionGrant,
  Step,
  resolveEvidencePolicy,
} from '@cairn/shared'
import type { EngineClock } from './clock.js'

export type EvidencePolicyResolution = ReturnType<typeof resolveEvidencePolicy>

export interface StepExecutionContext {
  readonly runId: string
  readonly stepRunId: string
  readonly attemptId: string
  readonly targetId: string
  readonly step: Step
  readonly input: JsonValue
  readonly context: Readonly<Record<string, JsonValue>>
  readonly signal: AbortSignal
  readonly clock: EngineClock
  readonly sessionGrant?: SessionGrant
  readonly evidencePolicy: EvidencePolicyResolution
  readonly grant: import('@cairn/shared').RunGrant
  readonly snapshot: import('@cairn/shared').RunSnapshot
}

export type StepExecutionOutcome =
  | {
      kind: 'success'
      output: JsonValue
      screenshot?: ScreenshotPointer
      trace?: ScreenshotPointer
      hung?: boolean
    }
  | {
      kind: 'failed' | 'cancelled' | 'needs_review'
      error: ExecutionError
      output?: JsonValue
      diagnostics?: ResolverDiagnostics
      screenshot?: ScreenshotPointer
      trace?: ScreenshotPointer
      timedOut?: boolean
      aborted?: boolean
      hung?: boolean
    }

export interface StepExecutor {
  readonly supportedTypes: readonly string[]
  execute(ctx: StepExecutionContext): Promise<StepExecutionOutcome>
}

export const STEP_EXECUTOR_REGISTRY = Symbol('STEP_EXECUTOR_REGISTRY')

export class StepExecutorRegistry {
  private readonly executors = new Map<string, StepExecutor>()

  constructor(executors: StepExecutor[] = []) {
    for (const executor of executors) {
      this.register(executor)
    }
  }

  register(executor: StepExecutor): this {
    for (const type of executor.supportedTypes) {
      this.executors.set(type, executor)
    }
    return this
  }

  get(type: string): StepExecutor | undefined {
    return this.executors.get(type)
  }

  has(type: string): boolean {
    return this.executors.has(type)
  }

  registeredTypes(): string[] {
    return Array.from(this.executors.keys())
  }
}
