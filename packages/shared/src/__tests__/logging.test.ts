import { describe, expect, it } from 'vitest'
import {
  LOGGING_CENSOR,
  LOGGING_REDACT_PATHS,
  PROCESS_LOG_EVENTS,
  bindLogFields,
  buildProcessLoggerBindings,
} from '../logging.js'

describe('LOGGING_REDACT_PATHS', () => {
  it('覆盖请求体里的 password 和 secret，避免密钥进日志', () => {
    expect(LOGGING_REDACT_PATHS).toContain('req.body.password')
    expect(LOGGING_REDACT_PATHS).toContain('req.body.secret')
    expect(LOGGING_REDACT_PATHS).toContain('req.body.account.password')
    expect(LOGGING_REDACT_PATHS).toContain('req.headers.authorization')
  })
})

describe('bindLogFields', () => {
  it('去掉 undefined，不把 unknown 当缺失字段的占位', () => {
    expect(
      bindLogFields({
        runId: 'run-1',
        stepRunId: undefined,
        attemptId: 'unknown',
        attemptNo: 1,
        hung: false,
      }),
    ).toEqual({ runId: 'run-1', attemptNo: 1, hung: false })
  })
})

describe('buildProcessLoggerBindings', () => {
  it('api 与 worker 共用脱敏清单，workerId 只在传入时进入 base', () => {
    const api = buildProcessLoggerBindings({ service: 'cairn-api', level: 'info' })
    expect(api.base).toEqual({ service: 'cairn-api' })
    expect(api.redact).toEqual({ paths: [...LOGGING_REDACT_PATHS], censor: LOGGING_CENSOR })

    const worker = buildProcessLoggerBindings({
      service: 'cairn-worker',
      level: 'debug',
      workerId: 'w-1',
    })
    expect(worker.base).toEqual({ service: 'cairn-worker', workerId: 'w-1' })
    expect(worker.level).toBe('debug')
  })
})

describe('PROCESS_LOG_EVENTS', () => {
  it('事件名是域.动作', () => {
    expect(PROCESS_LOG_EVENTS.runStarted).toBe('run.started')
    expect(PROCESS_LOG_EVENTS.attemptFinished).toBe('attempt.finished')
    expect(PROCESS_LOG_EVENTS.aiModelCallFailed).toBe('ai.model_call_failed')
  })
})
