/**
 * 唯一碰 playwright 的模块。Engine 不得 import 本文件。
 */

import type { BrowserContext, Page } from 'playwright'

export type LaunchSessionOpts = {
  headless: boolean
  executablePath?: string
}

export type BrowserHandle = {
  context: BrowserContext
  basePage: Page
  profileDir: string
}

export type TargetAuthInfo = {
  entryUrl: string
  loginUrl?: string | null
  loginFields?: {
    username?: { by: 'id' | 'name' | 'css'; value: string }
    password?: { by: 'id' | 'name' | 'css'; value: string }
    submit?: { by: 'id' | 'name' | 'css'; value: string }
  } | null
}

function locatorFor(
  page: Page,
  field: { by: 'id' | 'name' | 'css'; value: string },
) {
  if (field.by === 'id') return page.locator(`#${cssEscape(field.value)}`)
  if (field.by === 'name') return page.locator(`[name="${cssEscapeAttr(field.value)}"]`)
  return page.locator(field.value)
}

function cssEscape(value: string): string {
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1')
}

function cssEscapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function launchSession(
  profileDir: string,
  opts: LaunchSessionOpts,
): Promise<BrowserHandle> {
  let chromium: typeof import('playwright').chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch (error) {
    throw new BrowserRuntimeError(
      'BROWSER_UNAVAILABLE',
      error instanceof Error ? error.message : 'playwright 不可用',
    )
  }

  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: opts.headless,
      executablePath: opts.executablePath,
      args: ['--disable-dev-shm-usage'],
    })
    const basePage = context.pages()[0] ?? (await context.newPage())
    return { context, basePage, profileDir }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/SingletonLock|user data directory is already in use|ProcessSingleton/i.test(message)) {
      throw new BrowserRuntimeError('PROFILE_LOCKED', message)
    }
    if (/Executable doesn't exist|browserType\.launch|Failed to launch/i.test(message)) {
      throw new BrowserRuntimeError('BROWSER_UNAVAILABLE', message)
    }
    throw new BrowserRuntimeError('BROWSER_LAUNCH_FAILED', message)
  }
}

export async function probeHealth(handle: BrowserHandle): Promise<'HEALTHY' | 'UNHEALTHY'> {
  try {
    if (!handle.context.browser()?.isConnected() && handle.context.pages().length === 0) {
      // persistent context 可能 browser() 为 null，但 pages 仍可用
    }
    await handle.basePage.evaluate(() => true)
    return 'HEALTHY'
  } catch {
    return 'UNHEALTHY'
  }
}

export async function probeAuth(
  handle: BrowserHandle,
  target: TargetAuthInfo,
): Promise<'AUTHENTICATED' | 'EXPIRED'> {
  try {
    await handle.basePage.goto(target.entryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const url = handle.basePage.url()
    if (target.loginUrl) {
      const login = new URL(target.loginUrl, target.entryUrl)
      const current = new URL(url)
      if (
        current.pathname === login.pathname ||
        current.href.startsWith(login.href) ||
        current.pathname.includes('/login')
      ) {
        return 'EXPIRED'
      }
    }
    if (target.loginFields?.password) {
      const pwd = locatorFor(handle.basePage, target.loginFields.password)
      if (await pwd.count().then((n) => n > 0).catch(() => false)) {
        const visible = await pwd.first().isVisible().catch(() => false)
        if (visible) return 'EXPIRED'
      }
    }
    return 'AUTHENTICATED'
  } catch {
    return 'EXPIRED'
  }
}

export async function loginWithCredentials(
  handle: BrowserHandle,
  target: TargetAuthInfo,
  credential: { username: string; password: string },
): Promise<boolean> {
  const fields = target.loginFields
  if (!fields?.username || !fields.password || !fields.submit) return false
  const loginUrl = target.loginUrl ?? target.entryUrl
  await handle.basePage.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await locatorFor(handle.basePage, fields.username).fill(credential.username)
  await locatorFor(handle.basePage, fields.password).fill(credential.password)
  await locatorFor(handle.basePage, fields.submit).click()
  await handle.basePage.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {})
  const auth = await probeAuth(handle, target)
  return auth === 'AUTHENTICATED'
}

export async function stopSession(
  handle: BrowserHandle,
  graceMs = 3_000,
): Promise<'stopped' | 'unconfirmed'> {
  try {
    await Promise.race([
      handle.context.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), graceMs)),
    ])
    return 'stopped'
  } catch {
    try {
      await handle.context.close()
    } catch {
      return 'unconfirmed'
    }
    return 'unconfirmed'
  }
}

export async function openRunPage(handle: BrowserHandle): Promise<Page> {
  return handle.context.newPage()
}

export async function closePage(page: Page): Promise<void> {
  try {
    await page.close()
  } catch {
    // 已关
  }
}

export function countPages(handle: BrowserHandle): number {
  return handle.context.pages().length
}

export class BrowserRuntimeError extends Error {
  readonly code: 'BROWSER_UNAVAILABLE' | 'BROWSER_LAUNCH_FAILED' | 'PROFILE_LOCKED'

  constructor(
    code: 'BROWSER_UNAVAILABLE' | 'BROWSER_LAUNCH_FAILED' | 'PROFILE_LOCKED',
    message: string,
  ) {
    super(message)
    this.name = 'BrowserRuntimeError'
    this.code = code
  }
}
