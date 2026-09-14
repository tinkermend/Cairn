/**
 * 唯一碰 playwright 的模块。Engine 不得 import 本文件。
 */

import { targetScopeReady } from './target-scope'
import type { BrowserContext, Frame, Locator, Page } from 'playwright'
import type {
  LocatorCandidate,
  RelativeAnchor,
  TargetDescriptor,
  FrameStep,
} from '@cairn/shared'

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
      serviceWorkers: 'block',
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

/**
 * 自动登录。返回 false 表示「这次登录没成功」，**不抛异常**。
 *
 * 调用方按 D7 处理失败（置认证占用、Run → WAITING_FOR_AUTH）。所以页面结构不符、
 * 元素超时、导航失败都必须在函数内收敛成 false：让 Playwright 的错误逃出
 * `acquire` 会把一个可解释的认证失败变成调用方的未捕获异常，Run 也就得不到
 * WAITING_FOR_AUTH 这条正确的处置路径。
 */
export async function loginWithCredentials(
  handle: BrowserHandle,
  target: TargetAuthInfo,
  credential: { username: string; password: string },
): Promise<boolean> {
  const fields = target.loginFields
  if (!fields?.username || !fields.password || !fields.submit) return false
  try {
    const loginUrl = target.loginUrl ?? target.entryUrl
    await handle.basePage.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const user = locatorFor(handle.basePage, fields.username)
    await user.waitFor({ state: 'visible', timeout: 15_000 })
    await user.fill(credential.username)
    await locatorFor(handle.basePage, fields.password).fill(credential.password)
    await locatorFor(handle.basePage, fields.submit).click()
    await handle.basePage.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {})
    // Vue / XHR 登录不会整页跳转；等到离开 /login 再探针，避免过早判定 EXPIRED。
    await handle.basePage
      .waitForFunction('!location.pathname.includes("/login")', undefined, { timeout: 30_000 })
      .catch(() => {})
    const auth = await probeAuth(handle, target)
    return auth === 'AUTHENTICATED'
  } catch {
    return false
  }
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
  const page = await handle.context.newPage()
  await targetScopeReady(page)
  return page
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

export class SurfaceLostError extends Error {
  readonly code = 'SURFACE_LOST' as const
  constructor(message: string) {
    super(message)
    this.name = 'SurfaceLostError'
  }
}

export type FrameResolve = { frame: Frame; trail: string[] }

export async function resolveFramePath(
  page: Page,
  framePath: FrameStep[],
  timeoutMs = 8_000,
): Promise<FrameResolve> {
  // 整条 FramePath 共用一个截止时间：四层路径不该把预算乘以四。
  const deadline = Date.now() + timeoutMs
  let current: Frame = page.mainFrame()
  const trail: string[] = ['main']
  for (const step of framePath) {
    current = await waitForChildFrame(current, step, deadline)
    trail.push(frameLabel(current, step))
  }
  return { frame: current, trail }
}

/**
 * iframe 会先 attach 再导航，中间那段窗口里 `frame.url()` 是空串，按 urlPattern 一次快照就是 0 匹配。
 * 定位候选那层本来就有等待窗口（`countCandidate`），FramePath 没有等于把「还没加载完」判成「Frame 已失效」。
 * 匹配到多个不等待：那是 Descriptor 写得不够准，多等不会变清晰。
 */
async function waitForChildFrame(parent: Frame, step: FrameStep, deadline: number): Promise<Frame> {
  for (;;) {
    const matches: Frame[] = []
    for (const frame of parent.childFrames()) {
      if (await frameMatches(frame, step)) matches.push(frame)
    }
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) throw new SurfaceLostError('FramePath 匹配到多个 frame')
    if (Date.now() > deadline) throw new SurfaceLostError('FramePath 找不到对应 frame')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function frameMatches(frame: Frame, step: FrameStep): Promise<boolean> {
  const url = frame.url()
  const name = frame.name()
  if (step.urlPattern && !url.includes(step.urlPattern)) return false
  if (step.name && name !== step.name) return false
  if (step.selector) {
    let element
    try {
      element = await frame.frameElement()
      const hit = await element.evaluate((el, sel) => {
        const root = el.ownerDocument
        if (!root) return false
        return Array.from(root.querySelectorAll(sel)).includes(el)
      }, step.selector)
      if (!hit) return false
    } catch (error) {
      if (isSurfaceLost(error)) {
        throw new SurfaceLostError(error instanceof Error ? error.message : 'Frame 已失效')
      }
      return false
    } finally {
      await element?.dispose().catch(() => undefined)
    }
  }
  return Boolean(step.urlPattern || step.name || step.selector)
}

function frameLabel(frame: Frame, step: FrameStep): string {
  return step.name ?? step.urlPattern ?? step.selector ?? frame.url()
}

export function locatorForCandidate(scope: Page | Frame | Locator, candidate: LocatorCandidate): Locator {
  if (candidate.by === 'role') {
    return scope.getByRole(candidate.value as Parameters<Page['getByRole']>[0], {
      name: candidate.name,
      exact: Boolean(candidate.name),
    })
  }
  if (candidate.by === 'label') return scope.getByLabel(candidate.value, { exact: true })
  if (candidate.by === 'text') return scope.getByText(candidate.value, { exact: true })
  if (candidate.by === 'title') return scope.locator(`[title="${cssEscapeAttr(candidate.value)}"]`)
  if (candidate.by === 'testId') return scope.getByTestId(candidate.value)
  return scope.locator(candidate.value)
}

export function scopeForAnchor(scope: Page | Frame, anchor?: RelativeAnchor): Page | Frame | Locator {
  if (!anchor) return scope
  if (anchor.scope === 'row') {
    return scope.locator('tr, [role="row"], li').filter({ hasText: anchor.withinText })
  }
  return scope.getByText(anchor.withinText, { exact: false }).locator('xpath=ancestor::*[1]')
}

export async function countCandidate(
  scope: Page | Frame | Locator,
  candidate: LocatorCandidate,
  timeoutMs: number,
): Promise<number> {
  const locator = locatorForCandidate(scope, candidate)
  const deadline = Date.now() + timeoutMs
  let last = 0
  while (Date.now() <= deadline) {
    try {
      last = await locator.count()
    } catch (error) {
      if (isSurfaceLost(error)) throw new SurfaceLostError(error instanceof Error ? error.message : '页面上下文失效')
      throw error
    }
    if (last === 1) return 1
    if (last > 1) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return last
}

function isSurfaceLost(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /has been closed|Target closed|Execution context was destroyed|Frame was detached|most likely because of a navigation/i.test(
    message,
  )
}

export async function detectCapabilityGap(
  scope: Page | Frame,
  descriptor: TargetDescriptor,
): Promise<'canvas' | 'closed-shadow' | null> {
  try {
    const closed = await scope.locator('[data-cairn-closed-shadow]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        inner: String((node as { dataset?: { cairnInner?: string } }).dataset?.cairnInner ?? ''),
      })),
    )
    for (const host of closed) {
      if (
        descriptor.candidates.some(
          (candidate) =>
            candidate.value === host.inner || candidate.name === host.inner || candidate.value.includes('canvas'),
        )
      ) {
        return 'closed-shadow'
      }
    }
    for (const candidate of descriptor.candidates) {
      const locator = locatorForCandidate(scope, candidate)
      const n = await locator.count().catch(() => 0)
      if (n === 0 && candidate.by === 'css' && /canvas/i.test(candidate.value)) return 'canvas'
      if (n >= 1) {
        const tag = await locator
          .first()
          .evaluate((el) => el.tagName.toLowerCase())
          .catch(() => '')
        if (tag === 'canvas') return 'canvas'
      }
    }
  } catch (error) {
    if (isSurfaceLost(error)) throw new SurfaceLostError(error instanceof Error ? error.message : '页面上下文失效')
  }
  return null
}

export async function navigateInScope(
  page: Page,
  url: string,
  allowedOrigins: string[],
): Promise<{ href: string } | { outOfScope: true; href: string }> {
  const base = allowedOrigins[0]
  if (!base) return { outOfScope: true, href: url }
  const resolved = new URL(url, base.endsWith('/') ? base : `${base}/`)
  if (!allowedOrigins.includes(resolved.origin)) {
    return { outOfScope: true, href: resolved.href }
  }
  await page.goto(resolved.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  return { href: page.url() }
}

export async function clickLocator(locator: Locator): Promise<void> {
  await locator.click({ timeout: 5_000 })
}

export async function fillLocator(locator: Locator, value: string): Promise<void> {
  await locator.fill(value, { timeout: 5_000 })
}

export async function readLocator(
  locator: Locator,
  as: 'text' | 'value' | 'attribute',
  attribute?: string,
): Promise<string> {
  if (as === 'value') return locator.inputValue({ timeout: 5_000 })
  if (as === 'attribute') return (await locator.getAttribute(attribute ?? '', { timeout: 5_000 })) ?? ''
  return locator.innerText({ timeout: 5_000 })
}

export async function isLocatorVisible(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false)
}

export async function waitForPopup(page: Page, action: () => Promise<void>, timeoutMs = 1_500): Promise<Page | null> {
  const pending = page.context().waitForEvent('page', { timeout: timeoutMs }).catch(() => null)
  await action()
  return pending
}

/** 只收集 opener 为当前页的新窗口；默认 click 仍走 waitForPopup。 */
export async function waitForPopupsFrom(
  page: Page,
  action: () => Promise<void>,
  timeoutMs = 1_500,
): Promise<Page[]> {
  const found: Page[] = []
  const pending: Promise<void>[] = []
  const onPage = (opened: Page) => {
    pending.push(
      opened.opener().then((parent) => {
        if (parent === page) found.push(opened)
      }),
    )
  }
  page.context().on('page', onPage)
  try {
    await action()
    await new Promise((resolve) => setTimeout(resolve, timeoutMs))
    await Promise.all(pending)
    return found.filter((item) => !item.isClosed())
  } finally {
    page.context().off('page', onPage)
  }
}

export async function probeAuthOnPage(
  page: Page,
  target: TargetAuthInfo,
): Promise<'AUTHENTICATED' | 'EXPIRED'> {
  try {
    const url = page.url()
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
      const pwd = locatorFor(page, target.loginFields.password)
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

export async function screenshotPage(page: Page): Promise<Buffer> {
  await page
    .evaluate(`(() => {
      for (const el of document.querySelectorAll('input[type="password"]')) {
        el.style.webkitTextSecurity = 'disc'
        el.value = '••••'
      }
    })()`)
    .catch(() => undefined)
  return page.screenshot({ type: 'png', fullPage: true })
}

export function pageClosed(page: Page): boolean {
  return page.isClosed()
}

export type { Locator, Frame, Page }
