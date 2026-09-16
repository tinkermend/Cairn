/**
 * 唯一碰 playwright 的模块。Engine 不得 import 本文件。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { targetScopeReady } from './target-scope'
import type { BrowserContext, Frame, Locator, Page, Request } from 'playwright'
import type {
  LocatorCandidate,
  RelativeAnchor,
  TargetDescriptor,
  FrameStep,
  SessionGrant,
} from '@cairn/shared'

const occupancy = new AsyncLocalStorage<SessionGrant>()

export class NavigationOutcomeUnknownError extends Error {
  constructor() {
    super('页面导航请求已发出但响应失败，操作结果需要核查')
    this.name = 'NavigationOutcomeUnknownError'
  }
}

/** A completed Playwright click does not prove its form navigation succeeded. */
export async function withNavigationOutcome<T>(page: Page, action: () => Promise<T>): Promise<T> {
  let failedNavigation = false
  const onFailed = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) failedNavigation = true
  }
  page.on('requestfailed', onFailed)
  try {
    const value = await action()
    if (failedNavigation) throw new NavigationOutcomeUnknownError()
    return value
  } finally {
    page.off('requestfailed', onFailed)
  }
}
// RESTART is protected by the persisted idle-operation reservation, not a lease.
const restartAuthority = new AsyncLocalStorage<{ sessionId: string; expiresAt: number }>()
export function runWithSessionRestart<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return restartAuthority.run({ sessionId, expiresAt: Date.now() + 60_000 }, fn)
}
const occupancyRejects: Array<{ action: string; at: string }> = []

export class OccupancyRequiredError extends Error {
  readonly code = 'SESSION_OCCUPANCY_REQUIRED' as const
  constructor(readonly action: string) {
    super(`浏览器调用 ${action} 缺少合法占用 grant`)
    this.name = 'OccupancyRequiredError'
  }
}

export function runWithOccupancy<T>(grant: SessionGrant, fn: () => Promise<T> | T): Promise<T> | T {
  return occupancy.run(grant, fn)
}

export function currentOccupancyGrant(): SessionGrant | undefined {
  return occupancy.getStore()
}

export function takeOccupancyRejects(): Array<{ action: string; at: string }> {
  return occupancyRejects.splice(0)
}

function requireOccupancy(action: string): SessionGrant {
  const grant = occupancy.getStore()
  if (!grant || Date.parse(grant.expiresAt) <= Date.now()) {
    occupancyRejects.push({ action, at: new Date().toISOString() })
    throw new OccupancyRequiredError(action)
  }
  return grant
}

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
  if ((restartAuthority.getStore()?.expiresAt ?? 0) <= Date.now()) requireOccupancy('launchSession')
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

export async function probeHealth(handle: BrowserHandle): Promise<'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN'> {
  try {
    await handle.basePage.evaluate(() => true)
    return 'HEALTHY'
  } catch (error) {
    // Navigation replaces the JS execution context while the browser remains
    // healthy. Leave this sample unknown and retry on the next health cycle;
    // closing here would revoke a concurrently active Run or auth operation.
    const message = error instanceof Error ? error.message : String(error)
    if (/Execution context was destroyed|Cannot find context with (?:specified )?id|Inspected target navigated/i.test(message) &&
        !handle.basePage.isClosed() && handle.context.browser()?.isConnected() !== false) {
      return 'UNKNOWN'
    }
    return 'UNHEALTHY'
  }
}

function pageUrlUnusable(url: string): boolean {
  return !url || url === 'about:blank' || url.startsWith('chrome-error://') || url.startsWith('chrome://')
}

/** 当前 URL 是否仍像登录页。入口与登录同路径时不能单靠 URL 判过期。 */
export function loginUrlLooksPending(url: string, target: TargetAuthInfo): boolean {
  if (pageUrlUnusable(url)) return true
  try {
    const current = new URL(url)
    if (!target.loginUrl) {
      return current.pathname === '/login' || current.pathname.endsWith('/login')
    }
    const login = new URL(target.loginUrl, target.entryUrl)
    const entry = new URL(target.entryUrl)
    if (login.pathname === entry.pathname) return false
    return current.pathname === login.pathname || current.pathname.startsWith(`${login.pathname}/`)
  } catch {
    return true
  }
}

async function passwordFieldVisible(
  page: Page,
  target: TargetAuthInfo,
): Promise<boolean> {
  if (!target.loginFields?.password) return false
  const pwd = locatorFor(page, target.loginFields.password)
  if (!(await pwd.count().then((n) => n > 0).catch(() => false))) return false
  return pwd.first().isVisible().catch(() => false)
}

export async function inspectAuthOnPage(
  page: Page,
  target: TargetAuthInfo,
): Promise<'AUTHENTICATED' | 'EXPIRED'> {
  try {
    const url = page.url()
    if (await passwordFieldVisible(page, target)) return 'EXPIRED'
    if (loginUrlLooksPending(url, target)) return 'EXPIRED'
    return 'AUTHENTICATED'
  } catch {
    return 'EXPIRED'
  }
}

/**
 * 先看当前页，仍像未登录再打开入口核验 cookie。
 * 人工刚登完时常还停在 /login，只看当前 URL 会误判 EXPIRED。
 */
export async function verifyAuthOnPage(
  page: Page,
  target: TargetAuthInfo,
): Promise<'AUTHENTICATED' | 'EXPIRED'> {
  if ((restartAuthority.getStore()?.expiresAt ?? 0) <= Date.now()) requireOccupancy('verifyAuthOnPage')
  try {
    if ((await inspectAuthOnPage(page, target)) === 'AUTHENTICATED') return 'AUTHENTICATED'
    await page.goto(target.entryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return inspectAuthOnPage(page, target)
  } catch {
    return 'EXPIRED'
  }
}

export async function probeAuth(
  handle: BrowserHandle,
  target: TargetAuthInfo,
): Promise<'AUTHENTICATED' | 'EXPIRED'> {
  return verifyAuthOnPage(handle.basePage, target)
}

/**
 * 自动登录。返回 false 表示「这次登录没成功」，**不抛异常**。
 *
 * 调用方按 D7 处理失败（置认证占用、Run → WAITING_FOR_AUTH）。所以页面结构不符、
 * 元素超时、导航失败都必须在函数内收敛成 false：让 Playwright 的错误逃出
 * `acquire` 会把一个可解释的认证失败变成调用方的未捕获异常，Run 也就得不到
 * WAITING_FOR_AUTH 这条正确的处置路径。
 */
export async function submitLoginCredentials(
  handle: BrowserHandle,
  target: TargetAuthInfo,
  credential: { username: string; password: string },
  timeoutMs = 30_000,
  beforeAction?: () => void | Promise<void>,
): Promise<boolean> {
  requireOccupancy('submitLoginCredentials')
  const fields = target.loginFields
  if (!fields?.username || !fields.password || !fields.submit) return false
  let authorityRejected = false
  const authorize = async () => {
    try { await beforeAction?.() }
    catch (error) { authorityRejected = true; throw error }
  }
  try {
    const loginUrl = target.loginUrl ?? target.entryUrl
    await authorize()
    await handle.basePage.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    const user = locatorFor(handle.basePage, fields.username)
    await user.waitFor({ state: 'visible', timeout: Math.min(15_000, timeoutMs) })
    await authorize()
    await user.fill(credential.username)
    await authorize()
    await locatorFor(handle.basePage, fields.password).fill(credential.password)
    await authorize()
    await locatorFor(handle.basePage, fields.submit).click()
    await handle.basePage.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {})
    await handle.basePage
      .waitForFunction('!location.pathname.includes("/login")', undefined, { timeout: timeoutMs })
      .catch(() => {})
    return true
  } catch (error) {
    // Authorization failure is terminal; it is not a wrong-password result.
    if (authorityRejected) throw error
    return false
  }
}

export async function loginWithCredentials(
  handle: BrowserHandle,
  target: TargetAuthInfo,
  credential: { username: string; password: string },
  beforeAction?: () => void | Promise<void>,
): Promise<boolean> {
  requireOccupancy('loginWithCredentials')
  const submitted = await submitLoginCredentials(handle, target, credential, undefined, beforeAction)
  if (!submitted) return false
  try {
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
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      handle.context.close(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('close timeout')), graceMs) }),
    ])
    return 'stopped'
  } catch {
    // Do not wait on the same stuck browser a second time without a deadline.
    // The caller preserves LOST until shutdown can be positively confirmed.
    return 'unconfirmed'
  } finally {
    clearTimeout(timer)
  }
}

export async function openRunPage(handle: BrowserHandle): Promise<Page> {
  requireOccupancy('openRunPage')
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
  signal?: AbortSignal,
): Promise<number> {
  const locator = locatorForCandidate(scope, candidate)
  const deadline = Date.now() + timeoutMs
  let last = 0
  while (Date.now() <= deadline) {
    signal?.throwIfAborted()
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
  requireOccupancy('navigateInScope')
  const base = allowedOrigins[0]
  if (!base) return { outOfScope: true, href: url }
  const resolved = new URL(url, base.endsWith('/') ? base : `${base}/`)
  if (!allowedOrigins.includes(resolved.origin)) {
    return { outOfScope: true, href: resolved.href }
  }
  await page.goto(resolved.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  return { href: page.url() }
}

export async function gotoPage(page: Page, url: string, timeoutMs = 30_000): Promise<void> {
  requireOccupancy('gotoPage')
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
}

export async function clickLocator(
  locator: Locator,
  options?: {
    button?: 'left' | 'right' | 'middle'
    clickCount?: 1 | 2
    modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
  },
): Promise<void> {
  requireOccupancy('clickLocator')
  await locator.click({
    timeout: 5_000,
    button: options?.button ?? 'left',
    clickCount: options?.clickCount ?? 1,
    modifiers: options?.modifiers,
  })
}

export async function selectLocator(
  locator: Locator,
  input: { by: 'label' | 'value' | 'index'; value?: string; index?: number },
): Promise<void> {
  requireOccupancy('selectLocator')
  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
  const role = await locator.getAttribute('role').catch(() => null)
  const native = tag === 'select'
  const accessible = role === 'listbox' || role === 'combobox'
  if (!native && !accessible) {
    throw new BrowserCapabilityMissingError('自定义下拉缺少 listbox/combobox 角色，不能猜测坐标')
  }
  if (native) {
    if (input.by === 'index') {
      await locator.selectOption({ index: input.index ?? 0 }, { timeout: 5_000 })
      return
    }
    if (input.by === 'label') {
      await locator.selectOption({ label: input.value ?? '' }, { timeout: 5_000 })
      return
    }
    await locator.selectOption({ value: input.value ?? '' }, { timeout: 5_000 })
    return
  }
  await locator.click({ timeout: 5_000 })
  const page = locator.page()
  if (input.by === 'index') {
    await page.getByRole('option').nth(input.index ?? 0).click({ timeout: 5_000 })
    return
  }
  await page.getByRole('option', { name: input.value ?? '', exact: true }).click({ timeout: 5_000 })
}

export async function pressKeys(
  page: Page,
  keys: string[],
  target?: Locator,
): Promise<void> {
  requireOccupancy('pressKeys')
  if (target) await target.focus({ timeout: 5_000 })
  for (const key of keys) {
    await page.keyboard.press(key, { delay: 10 })
  }
}

export async function waitOnPage(
  page: Page,
  input: {
    kind: 'time' | 'visible' | 'hidden' | 'url' | 'text'
    locator?: Locator
    urlPattern?: string
    text?: string
    durationMs?: number
    timeoutMs?: number
  },
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('步骤已取消')
  const timeout = input.timeoutMs ?? 8_000
  if (input.kind === 'time') {
    const ms = input.durationMs ?? 0
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('步骤已取消'))
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    return
  }
  if (input.kind === 'url') {
    await page.waitForURL((url) => url.href.includes(input.urlPattern ?? ''), { timeout })
    return
  }
  if (!input.locator) throw new Error('等待条件缺少目标')
  if (input.kind === 'visible') {
    await input.locator.waitFor({ state: 'visible', timeout })
    return
  }
  if (input.kind === 'hidden') {
    await input.locator.waitFor({ state: 'hidden', timeout })
    return
  }
  await input.locator.filter({ hasText: input.text ?? '' }).first().waitFor({ state: 'visible', timeout })
}

export class BrowserCapabilityMissingError extends Error {
  readonly code = 'BROWSER_CAPABILITY_MISSING' as const
  constructor(message: string) {
    super(message)
    this.name = 'BrowserCapabilityMissingError'
  }
}

export async function fillLocator(locator: Locator, value: string): Promise<void> {
  requireOccupancy('fillLocator')
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
  return inspectAuthOnPage(page, target)
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
