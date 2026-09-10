import { describe, expect, it } from 'vitest'
import { LOGGING_REDACT_PATHS } from '../logging.js'

describe('LOGGING_REDACT_PATHS', () => {
  it('覆盖请求体里的 password，避免目标账号设密进日志', () => {
    expect(LOGGING_REDACT_PATHS).toContain('req.body.password')
    expect(LOGGING_REDACT_PATHS).toContain('req.body.account.password')
    expect(LOGGING_REDACT_PATHS).toContain('req.headers.authorization')
  })
})
