import { describe, expect, it } from 'vitest'
import { resolveLoginFieldsOnPage } from './runtime'

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
