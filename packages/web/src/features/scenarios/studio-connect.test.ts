import { describe, expect, it } from 'vitest'
import type { AccountSessionDetail } from '@cairn/shared'
import { classifyStudioSessionConnect, studioDisconnectedCopy } from './studio-connect'

const base = {
  session: null,
  currentOperation: null,
  lastAuthError: null,
} as AccountSessionDetail

describe('studioDisconnectedCopy', () => {
  it('准备中说明正在打开浏览器', () => {
    expect(studioDisconnectedCopy({ connecting: true }).title).toBe('正在准备会话')
  })

  it('上次登录页打不开时直接说出原因', () => {
    const copy = studioDisconnectedCopy({ connecting: false, lastAuthError: 'LOGIN_PAGE_UNREACHABLE' })
    expect(copy.body).toContain('目标登录页打不开')
    expect(copy.body).toContain('浏览器页')
  })
})

describe('classifyStudioSessionConnect', () => {
  it('会话已打开即可指认', () => {
    expect(
      classifyStudioSessionConnect({
        ...base,
        session: { status: 'OPEN' },
      } as AccountSessionDetail),
    ).toBe('open')
  })

  it('当前这次准备失败才算失败，不拿上次失败当这次结果', () => {
    expect(
      classifyStudioSessionConnect(
        {
          ...base,
          currentOperation: { id: 'old', kind: 'PREPARE', status: 'FAILED', reusedRunId: null },
        } as AccountSessionDetail,
        'new',
      ),
    ).toBe('pending')
    expect(
      classifyStudioSessionConnect(
        {
          ...base,
          lastAuthError: 'LOGIN_PAGE_UNREACHABLE',
          currentOperation: { id: 'new', kind: 'PREPARE', status: 'FAILED', reusedRunId: null },
        } as AccountSessionDetail,
        'new',
      ),
    ).toBe('failed')
  })
})
