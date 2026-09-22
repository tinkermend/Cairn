import { describe, expect, it, vi } from 'vitest'
import {
  confirmSubmittedLogin,
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

  it('about:blank 视为未登录，verify 会打开入口再判定', async () => {
    const page = fakePage('about:blank', { gotoUrl: 'http://127.0.0.1:4177/' })
    expect(loginUrlLooksPending('about:blank', hmi)).toBe(true)
    expect(await inspectAuthOnPage(page as never, hmi)).toBe('EXPIRED')
    expect(await withTestOccupancy(() => verifyAuthOnPage(page as never, hmi))).toBe('AUTHENTICATED')
    expect(page.goto).toHaveBeenCalledWith('http://127.0.0.1:4177/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
  })

  it('登录 URL 等于入口时不靠路径判过期', () => {
    expect(
      loginUrlLooksPending('http://shop.example/', {
        entryUrl: 'http://shop.example/',
        loginUrl: 'http://shop.example/',
      }),
    ).toBe(false)
  })

  it('hash 登录页与入口同 pathname 时仍判未登录', () => {
    const gin: TargetAuthInfo = {
      entryUrl: 'http://demo.gin-vue-admin.com/',
      loginUrl: 'http://demo.gin-vue-admin.com/#/login',
    }
    expect(loginUrlLooksPending('http://demo.gin-vue-admin.com/#/login', gin)).toBe(true)
    expect(loginUrlLooksPending('http://demo.gin-vue-admin.com/#/layout/dashboard', gin)).toBe(false)
    expect(loginUrlLooksPending('http://demo.gin-vue-admin.com/', gin)).toBe(false)
  })

  it('hash 登录页没有密码框定位也判未登录', async () => {
    const page = fakePage('http://demo.gin-vue-admin.com/#/login')
    expect(
      await inspectAuthOnPage(page as never, {
        entryUrl: 'http://demo.gin-vue-admin.com/',
        loginUrl: 'http://demo.gin-vue-admin.com/#/login',
      }),
    ).toBe('EXPIRED')
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

  it('入口页随后跳登录则未登录', async () => {
    let current = 'about:blank'
    const target: TargetAuthInfo = {
      entryUrl: 'http://61.144.35.2:18804/front/database/allInstance',
      loginUrl: 'http://61.144.35.2:18804/front/login',
      loginFields: { password: { by: 'css', value: 'input[type=password]' } },
    }
    const page = {
      url: () => current,
      goto: vi.fn(async (next: string) => {
        current = next
      }),
      waitForURL: vi.fn(async (predicate: (url: URL) => boolean) => {
        current = target.loginUrl!
        if (!predicate(new URL(current))) throw new Error('timeout')
      }),
      locator: () => ({
        count: async () => 0,
        first: () => ({
          isVisible: async () => false,
          waitFor: async () => {
            throw new Error('timeout')
          },
        }),
      }),
    }
    expect(await withTestOccupancy(() => verifyAuthOnPage(page as never, target))).toBe('EXPIRED')
    expect(page.waitForURL).toHaveBeenCalled()
  })

  it('入口页稳定且无登录框才算已登录', async () => {
    let current = 'about:blank'
    const target: TargetAuthInfo = {
      entryUrl: 'http://61.144.35.2:18804/front/database/allInstance',
      loginUrl: 'http://61.144.35.2:18804/front/login',
      loginFields: { password: { by: 'css', value: 'input[type=password]' } },
    }
    const page = {
      url: () => current,
      goto: vi.fn(async (next: string) => {
        current = next
      }),
      waitForURL: vi.fn(async () => {
        throw new Error('timeout')
      }),
      locator: () => ({
        count: async () => 0,
        first: () => ({
          isVisible: async () => false,
          waitFor: async () => {
            throw new Error('timeout')
          },
        }),
      }),
    }
    expect(await withTestOccupancy(() => verifyAuthOnPage(page as never, target))).toBe('AUTHENTICATED')
    expect(page.goto).toHaveBeenCalledWith(target.entryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
  })
})

describe('提交后确认登录', () => {
  it('无验证码且结果不明时打开入口核验 cookie', async () => {
    const page = fakePage('https://modelapi.im/login', {
      gotoUrl: 'https://modelapi.im/dashboard',
    })
    expect(
      await withTestOccupancy(() =>
        confirmSubmittedLogin(
          { basePage: page } as never,
          { entryUrl: 'https://modelapi.im/dashboard', loginUrl: 'https://modelapi.im/login' },
          { authenticated: false, submit: 'ambiguous' },
        ),
      ),
    ).toEqual({ authenticated: true, submit: 'authenticated' })
    expect(page.goto).toHaveBeenCalledWith('https://modelapi.im/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
  })

  it('有验证码时不打开入口，避免刷新挑战', async () => {
    const page = fakePage('https://demo.example/#/login', {
      gotoUrl: 'https://demo.example/#/dashboard',
    })
    expect(
      await withTestOccupancy(() =>
        confirmSubmittedLogin(
          { basePage: page } as never,
          {
            entryUrl: 'https://demo.example/',
            loginUrl: 'https://demo.example/#/login',
            captchaMode: 'image',
          },
          { authenticated: false, submit: 'ambiguous' },
        ),
      ),
    ).toEqual({ authenticated: false, submit: 'ambiguous' })
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('未提交时不把公开入口页当成登录成功', async () => {
    const page = fakePage('https://modelapi.im/login', {
      gotoUrl: 'https://modelapi.im/dashboard',
    })
    expect(
      await withTestOccupancy(() =>
        confirmSubmittedLogin(
          { basePage: page } as never,
          { entryUrl: 'https://modelapi.im/dashboard', loginUrl: 'https://modelapi.im/login' },
          { authenticated: false, submit: 'not_attempted' },
        ),
      ),
    ).toEqual({ authenticated: false, submit: 'not_attempted' })
    expect(page.goto).not.toHaveBeenCalled()
  })
})
