import { describe, expect, it, vi } from 'vitest'
import {
  inspectAuthOnPage,
  loginUrlLooksPending,
  verifyAuthOnPage,
  type TargetAuthInfo,
} from './runtime'
import { withTestOccupancy } from './test-occupancy'

const hmi: TargetAuthInfo = {
  entryUrl: 'http://127.0.0.1:4177/',
  loginUrl: 'http://127.0.0.1:4177/login',
}

const dpm: TargetAuthInfo = {
  entryUrl: 'http://61.144.35.2:18804/',
  loginUrl: 'http://61.144.35.2:18804/front/login',
  loginFields: { password: { by: 'css', value: 'input[type=password]' } },
}

function fakePage(url: string, options?: { passwordVisible?: boolean; gotoUrl?: string }) {
  let current = url
  return {
    url: () => current,
    goto: vi.fn(async (next: string) => {
      current = options?.gotoUrl ?? next
    }),
    locator: () => ({
      count: async () => (options?.passwordVisible ? 1 : 0),
      first: () => ({ isVisible: async () => Boolean(options?.passwordVisible) }),
    }),
  }
}

describe('登录探针', () => {
  it('入口页不是登录页', () => {
    expect(loginUrlLooksPending('http://127.0.0.1:4177/', hmi)).toBe(false)
    expect(loginUrlLooksPending('http://127.0.0.1:4177/login', hmi)).toBe(true)
  })

  it('登录 URL 等于入口时不靠路径判过期', () => {
    expect(
      loginUrlLooksPending('http://shop.example/', {
        entryUrl: 'http://shop.example/',
        loginUrl: 'http://shop.example/',
      }),
    ).toBe(false)
  })

  it('刚登完仍停在登录 URL 时，打开入口核验 cookie', async () => {
    const page = fakePage('http://61.144.35.2:18804/front/login', {
      gotoUrl: 'http://61.144.35.2:18804/front/home',
    })
    expect(await inspectAuthOnPage(page as never, dpm)).toBe('EXPIRED')
    expect(await withTestOccupancy(() => verifyAuthOnPage(page as never, dpm))).toBe('AUTHENTICATED')
    expect(page.goto).toHaveBeenCalledWith('http://61.144.35.2:18804/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
  })

  it('打开入口后仍见密码框则未登录', async () => {
    const page = fakePage('http://127.0.0.1:4177/login', {
      passwordVisible: true,
      gotoUrl: 'http://127.0.0.1:4177/login',
    })
    expect(
      await withTestOccupancy(() =>
        verifyAuthOnPage(page as never, {
          ...hmi,
          loginFields: { password: { by: 'id', value: 'password' } },
        }),
      ),
    ).toBe('EXPIRED')
  })
})
