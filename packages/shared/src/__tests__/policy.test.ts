import { describe, expect, it } from 'vitest'
import { DEFAULT_EXECUTOR_VERSIONS, executorVersionsMatch } from '../policy.js'

describe('executorVersionsMatch', () => {
  it('旧快照只有夹具三键仍通过', () => {
    expect(executorVersionsMatch({ echo: '1', delay: '1', fail: '1' })).toBe(true)
    expect(executorVersionsMatch({ echo: '1', delay: '1', fail: '1' }, ['echo'])).toBe(true)
  })

  it('用到浏览器步骤时缺少对应键则失败', () => {
    expect(executorVersionsMatch({ echo: '1', delay: '1', fail: '1' }, ['navigate'])).toBe(false)
    expect(
      executorVersionsMatch(
        { echo: '1', delay: '1', fail: '1', navigate: '1' },
        ['navigate'],
      ),
    ).toBe(true)
  })

  it('版本号对不上失败', () => {
    expect(executorVersionsMatch({ ...DEFAULT_EXECUTOR_VERSIONS, echo: '2' })).toBe(false)
    expect(executorVersionsMatch(undefined)).toBe(false)
  })

  it('只用到的键参与校验：Echo 快照不因 click 版本变化失效', () => {
    expect(executorVersionsMatch({ echo: '1', click: '99' }, ['echo'])).toBe(true)
    expect(executorVersionsMatch({ echo: '1', click: '99' }, ['echo', 'click'])).toBe(false)
    expect(executorVersionsMatch({ echo: '1' }, ['echo'])).toBe(true)
  })
})
