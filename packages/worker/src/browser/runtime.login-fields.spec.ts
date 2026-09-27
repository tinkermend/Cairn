import { describe, expect, it, vi } from 'vitest'
import { attemptLoginCredentials, resolveLoginFieldsOnPage, runWithOccupancy } from './runtime'

function fakePage(visible: string[]) {
  const match = (sel: string) => visible.includes(sel)
  const makeLocator = (sel: string) => ({
    first: () => ({
      isVisible: async () => match(sel),
      locator: (inner: string) => makeLocator(inner),
      count: async () => (match(sel) ? 1 : 0),
    }),
    isVisible: async () => match(sel),
    count: async () => (match(sel) ? 1 : 0),
    nth: () => ({ isVisible: async () => false }),
    locator: (inner: string) => makeLocator(inner),
  })
  return { locator: (sel: string) => makeLocator(sel) }
}

describe('resolveLoginFieldsOnPage', () => {
  it('未指定定位时按平台常见字段命中', async () => {
    const page = fakePage(['#username', 'input[type="password"]', 'button[type="submit"]'])
    const resolved = await resolveLoginFieldsOnPage(page as never, null)
    expect(resolved).not.toBeNull()
  })

  it('手填定位不可见且无启发式命中时不假装已解析', async () => {
    const page = fakePage([])
    expect(
      await resolveLoginFieldsOnPage(page as never, {
        username: { by: 'css', value: '#never-login' },
        password: { by: 'css', value: '#pass' },
        submit: { by: 'css', value: '#go' },
      }),
    ).toBeNull()
  })

  it('只手填密码框时其余角色仍可走启发式', async () => {
    const page = fakePage(['#pwd', '#username', 'button[type="submit"]'])
    const resolved = await resolveLoginFieldsOnPage(page as never, {
      password: { by: 'id', value: 'pwd' },
    })
    expect(resolved).not.toBeNull()
  })
})

describe('attemptLoginCredentials 空密码守卫', () => {
  it('页面有密码框且传入空密码时返回 not_attempted，且不填写用户名或密码也不点击提交', async () => {
    const userFill = vi.fn()
    const passFill = vi.fn()
    const submitClick = vi.fn()
    const userWaitFor = vi.fn()
    const visible = ['#username', 'input[type="password"]', 'button[type="submit"]']
    const match = (sel: string) => visible.includes(sel)
    const makeLocator = (sel: string) => ({
      first: () => ({
        isVisible: async () => match(sel),
        locator: (inner: string) => makeLocator(inner),
        count: async () => (match(sel) ? 1 : 0),
        waitFor: userWaitFor,
        fill: sel === '#username' ? userFill : passFill,
        click: submitClick,
      }),
      isVisible: async () => match(sel),
      count: async () => (match(sel) ? 1 : 0),
      nth: () => ({ isVisible: async () => false }),
      locator: (inner: string) => makeLocator(inner),
      waitFor: userWaitFor,
      fill: sel === '#username' ? userFill : passFill,
      click: submitClick,
    })
    const mockPage = {
      url: () => 'https://example.com/login',
      goto: vi.fn(async () => {}),
      locator: (sel: string) => makeLocator(sel),
    }
    const mockHandle = {
      basePage: mockPage,
    } as any
    const target = {
      entryUrl: 'https://example.com/login',
    } as any
    const grant = {
      sessionId: 's',
      leaseId: 'l',
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      purpose: 'EXECUTION' as const,
      ownerKind: 'RUN' as const,
      runId: 'r',
      operationId: null,
    }

    const res = await runWithOccupancy(grant, async () => {
      return attemptLoginCredentials(mockHandle, target, {
        username: 'alice',
        password: '',
      })
    })

    expect(res).toEqual({ authenticated: false, submit: 'not_attempted' })
    expect(userFill).not.toHaveBeenCalled()
    expect(passFill).not.toHaveBeenCalled()
    expect(submitClick).not.toHaveBeenCalled()
  })
})

