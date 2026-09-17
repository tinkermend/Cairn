import type { Logger } from '@nestjs/common'
import { PROCESS_LOG_EVENTS, bindLogFields } from '@cairn/shared'

export function emitAiModelCallLog(
  logger: Pick<Logger, 'debug' | 'warn'>,
  input: {
    runId?: string
    stepRunId?: string
    attemptId?: string
    model?: string
    durationMs: number
    phase: 'completed' | 'failed'
    inputTokens?: number | null
    outputTokens?: number | null
    errorCode?: string
  },
): void {
  if (!input.runId || !input.stepRunId || !input.attemptId) return
  const fields = bindLogFields({
    runId: input.runId,
    stepRunId: input.stepRunId,
    attemptId: input.attemptId,
    model: input.model,
    durationMs: input.durationMs,
    phase: input.phase,
    inputTokens: input.inputTokens ?? undefined,
    outputTokens: input.outputTokens ?? undefined,
    errorCode: input.errorCode,
  })
  if (input.phase === 'failed') {
    logger.warn(fields, PROCESS_LOG_EVENTS.aiModelCallFailed)
    return
  }
  logger.debug(fields, PROCESS_LOG_EVENTS.aiModelCall)
}
