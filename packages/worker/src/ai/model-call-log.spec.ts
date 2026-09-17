import { describe, expect, it, vi } from 'vitest'
import { PROCESS_LOG_EVENTS } from '@cairn/shared'
import { emitAiModelCallLog } from './model-call-log.js'

describe('emitAiModelCallLog', () => {
  it('PL05 成功调用只打 debug，不含 prompt', () => {
    const logger = { debug: vi.fn(), warn: vi.fn() }
    emitAiModelCallLog(logger, {
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      model: 'demo-model',
      durationMs: 12,
      phase: 'completed',
      inputTokens: 3,
      outputTokens: 5,
    })
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        model: 'demo-model',
        durationMs: 12,
        phase: 'completed',
        inputTokens: 3,
        outputTokens: 5,
      }),
      PROCESS_LOG_EVENTS.aiModelCall,
    )
    const fields = logger.debug.mock.calls[0]?.[0] as Record<string, unknown>
    expect(JSON.stringify(fields)).not.toMatch(/prompt|completion|secret/i)
  })

  it('PL06 失败调用打 warn，带 Attempt 三件套与 errorCode', () => {
    const logger = { debug: vi.fn(), warn: vi.fn() }
    emitAiModelCallLog(logger, {
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      model: 'demo-model',
      durationMs: 8,
      phase: 'failed',
      errorCode: 'AI_CALL_FAILED',
    })
    expect(logger.debug).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        errorCode: 'AI_CALL_FAILED',
      }),
      PROCESS_LOG_EVENTS.aiModelCallFailed,
    )
  })

  it('缺 Attempt 三件套时不编 ID', () => {
    const logger = { debug: vi.fn(), warn: vi.fn() }
    emitAiModelCallLog(logger, { durationMs: 1, phase: 'completed', runId: 'run-1' })
    expect(logger.debug).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
