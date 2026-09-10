import { describe, expect, it } from 'vitest'
import { executionErrorSchema } from '../runtime-error.js'

const valid = {
  code: 'STEP_FAILED',
  category: 'EXECUTOR',
  retryable: true,
  safeMessage: '步骤执行失败',
}

describe('executionErrorSchema', () => {
  it('接受最小执行错误', () => {
    expect(executionErrorSchema.parse(valid)).toEqual(valid)
  })

  it('接受不含堆栈的 cause', () => {
    const withCause = {
      ...valid,
      cause: { code: 'ECHO_SOURCE_MISSING', message: 'context 中没有 echo_1' },
    }
    expect(executionErrorSchema.parse(withCause)).toEqual(withCause)
  })

  it('拒绝堆栈——内部细节不能进跨进程错误', () => {
    expect(() =>
      executionErrorSchema.parse({
        ...valid,
        cause: { message: 'boom', stack: 'Error: boom\n    at fail' },
      }),
    ).toThrow()
  })

  it('拒绝未知 category', () => {
    expect(() => executionErrorSchema.parse({ ...valid, category: 'SIDE_EFFECT' })).toThrow()
  })

  it('retryable 必须是布尔，缺省不算提示', () => {
    const { retryable: _drop, ...without } = valid
    expect(() => executionErrorSchema.parse(without)).toThrow()
  })
})
