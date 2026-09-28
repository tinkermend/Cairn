/**
 * 唯一碰 playwright 的模块。Engine 不得 import 本文件。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { installedScopeAllows, targetScopeReady } from './target-scope'
import type { BrowserContext, Frame, Locator, Page, Request } from 'playwright'
import {
  authRoutePath,
  DEFAULT_CAPTCHA_MAX_ATTEMPTS,
  DEFAULT_CAPTCHA_SOLVE_TIMEOUT_MS,
  DEFAULT_SLIDER_DRAG_MAX_DURATION_MS,
  DEFAULT_SLIDER_DRAG_MIN_DURATION_MS,
  resolveLoginLeaveTimeoutMs,
  LOGIN_FIELD_HEURISTICS,
  loginLocatorCandidates,
  type LocatorCandidate,
  type LoginLocator,
  type PlatformSessionAuth,
  type RelativeAnchor,
  type TargetDescriptor,
  type FrameStep,
  type SessionGrant,
  type TargetCaptchaDefinition,
  type TargetLoginFields,
  DEFAULT_MANAGED_VIEWPORT,
} from '@cairn/shared'
import {
  classifyLoginSubmitText,
  detectChallenge,
  shouldRetryLoginSubmit,
  solveChallenge,
  type LoginAttemptResult,
} from './captcha/index.js'
import { generateTotp } from './totp.js'
import { SessionLeaseError } from './session-error.js'

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
const occupancyRejects: Array<{ action: string; at: string; expiresAt?: string }> = []

export class OccupancyRequiredError extends Error {
  readonly code = 'SESSION_OCCUPANCY_REQUIRED' as const
  constructor(
    readonly action: string,
    readonly detail?: { expiresAt?: string; now: string },
  ) {
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
  const now = new Date().toISOString()
  if (!grant || Date.parse(grant.expiresAt) <= Date.now()) {
    occupancyRejects.push({ action, at: now, expiresAt: grant?.expiresAt })
    throw new OccupancyRequiredError(action, { expiresAt: grant?.expiresAt, now })
  }
  return grant
}

export type LaunchSessionOpts = {
  headless: boolean
  executablePath?: string
  viewport?: { width: number; height: number } | null
  storageState?: unknown
  workerId?: string
  sessionId?: string
  cairnHost?: string
}

export type BrowserHandle = {
  context: BrowserContext
  basePage: Page
  isolation: 'SHARED' | 'DEDICATED'
  hostId: string | null
  profileDir: string | null
}

export type TargetAuthInfo = {
  entryUrl: string
  loginUrl?: string | null
  loginFields?: {
    username?: { by: 'id' | 'name' | 'css'; value: string }
    password?: { by: 'id' | 'name' | 'css'; value: string }
    totp?: { by: 'id' | 'name' | 'css'; value: string }
    submit?: { by: 'id' | 'name' | 'css'; value: string }
  } | null
  captchaMode?: string
  captcha?: TargetCaptchaDefinition | null
  captchaMaxAttempts?: number
  captchaSolveTimeoutMs?: number
  captchaHumanWaitSeconds?: number
  sliderDragMinDurationMs?: number
  sliderDragMaxDurationMs?: number
  loginLeaveTimeoutMs?: number | null
  landingSettleMode?: 'default' | 'off' | null
  landingSettleTimeoutMs?: number | null
}

export function applySessionAuthToTarget(
  target: TargetAuthInfo,
  sessionAuth?: Pick<
    PlatformSessionAuth,
    | 'captchaMaxAttempts'
    | 'captchaSolveTimeoutMs'
    | 'captchaHumanWaitSeconds'
    | 'sliderDragMinDurationMs'
    | 'sliderDragMaxDurationMs'
    | 'loginLeaveTimeoutMs'
    | 'loginTimeoutMs'
  > | null,
): TargetAuthInfo {
  if (!sessionAuth) return target
  return {
    ...target,
    captchaMaxAttempts: sessionAuth.captchaMaxAttempts,
    captchaSolveTimeoutMs: sessionAuth.captchaSolveTimeoutMs,
    captchaHumanWaitSeconds: sessionAuth.captchaHumanWaitSeconds,
    sliderDragMinDurationMs: sessionAuth.sliderDragMinDurationMs,
    sliderDragMaxDurationMs: sessionAuth.sliderDragMaxDurationMs,
    loginLeaveTimeoutMs: resolveLoginLeaveTimeoutMs({
      targetTimeoutMs: target.loginLeaveTimeoutMs,
      platformTimeoutMs: sessionAuth.loginLeaveTimeoutMs,
      loginTimeoutMs: sessionAuth.loginTimeoutMs,
    }),
  }
}

function locatorFor(
  page: Page,
  field: { by: 'id' | 'name' | 'css'; value: string },
) {
  if (field.by === 'id') return page.locator(`#${cssEscape(field.value)}`)
  if (field.by === 'name') return page.locator(`[name="${cssEscapeAttr(field.value)}"]`)
  return page.locator(field.value)
}

async function firstVisibleLoginLocator(
  page: Page,
  candidates: readonly LoginLocator[],
): Promise<Locator | null> {
  for (const candidate of candidates) {
    const loc = locatorFor(page, candidate).first()
    if (await loc.isVisible().catch(() => false)) return loc
  }
  return null
}

async function inferUsernameNearPassword(page: Page, password: Locator): Promise<Locator | null> {
  const scoped = [
    'form:has(input[type="password"]) input[type="text"]',
    'form:has(input[type="password"]) input[type="email"]',
    'form:has(input[type="password"]) input[type="tel"]',
    'form:has(input[type="password"]) input:not([type])',
  ]
  for (const css of scoped) {
    const loc = page.locator(css).first()
    if (await loc.isVisible().catch(() => false)) return loc
  }
  const sameForm = password.locator(
    'xpath=ancestor::form[1]//input[(not(@type) or @type="text" or @type="email" or @type="tel")]',
  )
  const formCount = await sameForm.count().catch(() => 0)
  for (let i = 0; i < formCount; i += 1) {
    const el = sameForm.nth(i)
    if (await el.isVisible().catch(() => false)) return el
  }
  const preceding = password.locator(
    'xpath=preceding::input[(not(@type) or @type="text" or @type="email" or @type="tel")][1]',
  )
  if ((await preceding.count().catch(() => 0)) > 0 && (await preceding.isVisible().catch(() => false))) {
    return preceding
  }
  return null
}

async function inferSubmitNearPassword(page: Page, password: Locator): Promise<Locator | null> {
  const scoped = [
    'form:has(input[type="password"]) button[type="submit"]',
    'form:has(input[type="password"]) input[type="submit"]',
    'form:has(input[type="password"]) button:not([type="button"]):not([type="reset"])',
  ]
  for (const css of scoped) {
    const loc = page.locator(css).first()
    if (await loc.isVisible().catch(() => false)) return loc
  }
  const following = password.locator(
    'xpath=following::*[self::button or self::input[@type="submit"]][not(@type) or @type="submit"][1]',
  )
  if ((await following.count().catch(() => 0)) > 0 && (await following.isVisible().catch(() => false))) {
    return following
  }
  return null
}

export async function resolveLoginFieldsOnPage(
  page: Page,
  fields?: TargetLoginFields | null,
): Promise<{ username: Locator; password: Locator; submit: Locator; totp?: Locator } | null> {
  const password = await firstVisibleLoginLocator(page, loginLocatorCandidates('password', fields?.password))
  if (!password) return null
  const username =
    (await firstVisibleLoginLocator(page, loginLocatorCandidates('username', fields?.username))) ??
    (fields?.username ? null : await inferUsernameNearPassword(page, password))
  const submit =
    (await firstVisibleLoginLocator(page, loginLocatorCandidates('submit', fields?.submit))) ??
    (fields?.submit ? null : await inferSubmitNearPassword(page, password))
  if (!username || !submit) return null
  const totp = (await firstVisibleLoginLocator(page, loginLocatorCandidates('totp', fields?.totp))) ?? undefined
  return { username, password, submit, totp }
}

async function waitForLoginForm(
  page: Page,
  fields: TargetLoginFields | null | undefined,
  timeoutMs: number,
): Promise<void> {
  const candidates = loginLocatorCandidates('password', fields?.password)
  await Promise.any(
    candidates.map((candidate) =>
      locatorFor(page, candidate).first().waitFor({ state: 'visible', timeout: timeoutMs }),
    ),
  ).catch(() => undefined)
}

function cssEscape(value: string): string {
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1')
}

function cssEscapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function injectStorageState(
  context: BrowserContext,
  storageState?: unknown,
): Promise<void> {
  if (!storageState || typeof storageState !== 'object') return
  const raw = storageState as {
    cookies?: Array<{ name: string; value: string; domain?: string; path?: string; [key: string]: unknown }>
    origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>
  }
  if (Array.isArray(raw.cookies) && raw.cookies.length > 0) {
    try {
      await context.addCookies(raw.cookies as any)
    } catch (error) {
      throw new SessionLeaseError(
        'AUTH_STORAGE_STATE_INVALID',
        `Cookie 注入失败: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (Array.isArray(raw.origins) && raw.origins.length > 0) {
    for (const originEntry of raw.origins) {
      if (!originEntry.origin || !Array.isArray(originEntry.localStorage)) continue
      const origin = originEntry.origin
      const entries = originEntry.localStorage
      try {
        await context.addInitScript(
          `if (window.location.origin === ${JSON.stringify(origin)}) {
            const flagKey = '__cairn_storage_injected__';
            if (!window.localStorage.getItem(flagKey)) {
              window.localStorage.setItem(flagKey, '1');
              const items = ${JSON.stringify(entries)};
              for (const item of items) {
                try { window.localStorage.setItem(item.name, item.value); } catch (_) {}
              }
            }
          }`,
        )
      } catch (error) {
        throw new SessionLeaseError(
          'AUTH_STORAGE_STATE_INVALID',
          `LocalStorage 脚本注入失败: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
}

export function buildContextOptions(opts: LaunchSessionOpts) {
  return {
    serviceWorkers: 'block' as const,
    viewport: opts.viewport !== undefined ? (opts.viewport ?? undefined) : DEFAULT_MANAGED_VIEWPORT,
    acceptDownloads: true,
  }
}

export async function openDedicatedSession(
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

  const cairnHostArg = opts.cairnHost
    ? `--cairn-host=${opts.cairnHost}`
    : opts.workerId && opts.sessionId
      ? `--cairn-host=${opts.workerId}/dedicated/${opts.sessionId}`
      : undefined

  const args = ['--disable-dev-shm-usage']
  if (cairnHostArg) args.push(cairnHostArg)

  const common = buildContextOptions(opts)

  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: opts.headless,
      executablePath: opts.executablePath,
      args,
      ...common,
    })
    if (opts.storageState) {
      try {
        await injectStorageState(context, opts.storageState)
      } catch (error) {
        await context.close().catch(() => {})
        throw error
      }
    }
    const basePage = context.pages()[0] ?? (await context.newPage())
    return {
      context,
      basePage,
      isolation: 'DEDICATED',
      hostId: null,
      profileDir,
    }
  } catch (error) {
    if (error instanceof SessionLeaseError) {
      throw error
    }
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

export async function openSharedSession(
  host: { browser: import('playwright').Browser; hostId: string },
  opts: LaunchSessionOpts,
): Promise<BrowserHandle> {
  if ((restartAuthority.getStore()?.expiresAt ?? 0) <= Date.now()) requireOccupancy('launchSession')
  const common = buildContextOptions(opts)
  let context: import('playwright').BrowserContext | undefined
  try {
    context = await host.browser.newContext(common)
    if (opts.storageState) {
      await injectStorageState(context, opts.storageState)
    }
    const basePage = await context.newPage()
    return {
      context,
      basePage,
      isolation: 'SHARED',
      hostId: host.hostId,
      profileDir: null,
    }
  } catch (error) {
    if (context) {
      await context.close().catch(() => {})
    }
    if (error instanceof SessionLeaseError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new BrowserRuntimeError('BROWSER_LAUNCH_FAILED', message)
  }
}

export async function launchSession(
  profileDir: string,
  opts: LaunchSessionOpts,
): Promise<BrowserHandle> {
  return openDedicatedSession(profileDir, opts)
}

export async function probeHealth(handle: BrowserHandle): Promise<'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN'> {
  if (handle.context.browser()?.isConnected() === false) {
    return 'UNHEALTHY'
  }
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

function expectsLoginChallenge(target: TargetAuthInfo): boolean {
  return (
    target.captchaMode === 'image' ||
    target.captchaMode === 'slider' ||
    target.captchaMode === 'graphic' ||
    Boolean(target.captcha)
  )
}

async function waitForLoginChallenge(
  page: Page,
  target: TargetAuthInfo,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof detectChallenge>>> {
  if (!expectsLoginChallenge(target)) return detectChallenge(page, target.captcha)
  await page
    .locator('input[placeholder*="验证码"], img[src^="data:image/"]')
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => undefined)
  let challenge = await detectChallenge(page, target.captcha)
  const deadline = Date.now() + Math.min(2_000, timeoutMs)
  while (!challenge && Date.now() < deadline) {
    await page.waitForTimeout(200)
    challenge = await detectChallenge(page, target.captcha)
  }
  return challenge
}

async function waitUntilLeftLogin(page: Page, loginUrl: string, entryUrl: string, timeoutMs: number): Promise<boolean> {
  const loginPath = authRoutePath(new URL(loginUrl, entryUrl))
  return page
    .waitForFunction(
      `(() => {
        const hashPath = (location.hash.replace(/^#/, '').split('?')[0] || '').trim()
        const path = (hashPath.startsWith('/') ? hashPath : location.pathname).replace(/\\/+$/, '') || '/'
        const expected = ${JSON.stringify(loginPath)}
        return path !== expected && !path.startsWith(expected + '/')
      })()`,
      undefined,
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false)
}

function looksLikeLoginPath(path: string): boolean {
  return path === '/login' || path.endsWith('/login')
}

/** 当前 URL 是否仍像登录页。入口与登录同路径时不能单靠 URL 判过期。 */
export function loginUrlLooksPending(url: string, target: TargetAuthInfo): boolean {
  if (pageUrlUnusable(url)) return true
  try {
    const current = new URL(url)
    if (!target.loginUrl) return looksLikeLoginPath(authRoutePath(current))
    const login = new URL(target.loginUrl, target.entryUrl)
    const entry = new URL(target.entryUrl)
    const loginPath = authRoutePath(login)
    const entryPath = authRoutePath(entry)
    if (loginPath === entryPath) return false
    const currentPath = authRoutePath(current)
    return currentPath === loginPath || currentPath.startsWith(`${loginPath}/`)
  } catch {
    return true
  }
}

async function passwordFieldVisible(
  page: Page,
  target: TargetAuthInfo,
): Promise<boolean> {
  const specified = target.loginFields?.password
  const candidates = specified ? [specified] : [...LOGIN_FIELD_HEURISTICS.password]
  return (await firstVisibleLoginLocator(page, candidates)) != null
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

const AUTH_REDIRECT_SETTLE_MS = 5_000

/** 未登录 SPA 常先落到入口再跳登录；只在入口路径上等这次跳转。 */
function shouldWaitForLoginBounce(url: string, target: TargetAuthInfo): boolean {
  if (pageUrlUnusable(url)) return false
  try {
    const current = new URL(url)
    const entry = new URL(target.entryUrl)
    return current.origin === entry.origin && current.pathname === entry.pathname
  } catch {
    return false
  }
}

async function settleLegacyAuthObservation(
  page: Page,
  target: TargetAuthInfo,
  timeoutMs = AUTH_REDIRECT_SETTLE_MS,
): Promise<void> {
  if ((await inspectAuthOnPage(page, target)) === 'EXPIRED') return
  if (!shouldWaitForLoginBounce(page.url(), target)) return
  const waiters: Array<Promise<unknown>> = []
  if (typeof page.waitForURL === 'function' && target.loginUrl) {
    const login = new URL(target.loginUrl, target.entryUrl)
    const entry = new URL(target.entryUrl)
    if (login.pathname !== entry.pathname) {
      waiters.push(
        page.waitForURL((url) => loginUrlLooksPending(url.toString(), target), { timeout: timeoutMs }),
      )
    }
  }
  const passwordCandidates = target.loginFields?.password
    ? [target.loginFields.password]
    : [...LOGIN_FIELD_HEURISTICS.password]
  for (const candidate of passwordCandidates) {
    const first = locatorFor(page, candidate).first()
    if (typeof first.waitFor === 'function') {
      waiters.push(first.waitFor({ state: 'visible', timeout: timeoutMs }))
    }
  }
  if (waiters.length === 0) return
  await Promise.any(waiters).catch(() => undefined)
}

/**
 * 先看当前页，仍像未登录再打开入口核验 cookie。
 * 人工刚登完时常还停在 /login，只看当前 URL 会误判 EXPIRED。
 * 入口页在 domcontentloaded 时可能还没跳登录，必须等跳转或登录框出现再判。
 */
export async function verifyAuthOnPage(
  page: Page,
  target: TargetAuthInfo,
): Promise<'AUTHENTICATED' | 'EXPIRED'> {
  if ((restartAuthority.getStore()?.expiresAt ?? 0) <= Date.now()) requireOccupancy('verifyAuthOnPage')
  try {
    await settleLegacyAuthObservation(page, target)
    if ((await inspectAuthOnPage(page, target)) === 'AUTHENTICATED') return 'AUTHENTICATED'
    await page.goto(target.entryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await settleLegacyAuthObservation(page, target)
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
export async function attemptLoginCredentials(
  handle: BrowserHandle,
  target: TargetAuthInfo,
  credential: { username: string; password: string; totpSecret?: string },
  timeoutMs = 30_000,
  beforeAction?: () => void | Promise<void>,
): Promise<LoginAttemptResult> {
  requireOccupancy('submitLoginCredentials')
  const fields = target.loginFields
  let authorityRejected = false
  const authorize = async () => {
    try { await beforeAction?.() }
    catch (error) { authorityRejected = true; throw error }
  }
  let lastSubmit: LoginAttemptResult['submit'] = 'unsolved'
  try {
    const loginUrl = target.loginUrl ?? target.entryUrl
    await authorize()
    // 持久化 Profile 上同 hash 再 goto 常常不重载，验证码接口也不会再打。
    if (!pageUrlUnusable(handle.basePage.url())) {
      await handle.basePage.goto('about:blank', { timeout: Math.min(5_000, timeoutMs) }).catch(() => undefined)
    }
    await handle.basePage.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await waitForLoginForm(handle.basePage, fields, Math.min(15_000, timeoutMs))
    const resolved = await resolveLoginFieldsOnPage(handle.basePage, fields)
    if (!resolved) {
      return { authenticated: false, submit: 'not_attempted' }
    }
    if (resolved.password && credential.password.length === 0) {
      console.error(
        JSON.stringify({
          event: 'login.empty_password_blocked',
          reason: '页面存在密码框但凭据密码为空，拒绝提交以保护账号安全',
        }),
      )
      return { authenticated: false, submit: 'not_attempted' }
    }
    const user = resolved.username
    await user.waitFor({ state: 'visible', timeout: Math.min(15_000, timeoutMs) })

    const captchaTries = expectsLoginChallenge(target)
      ? Math.max(1, target.captchaMaxAttempts ?? DEFAULT_CAPTCHA_MAX_ATTEMPTS)
      : 1
    const solveTimeoutMs = Math.min(target.captchaSolveTimeoutMs ?? DEFAULT_CAPTCHA_SOLVE_TIMEOUT_MS, timeoutMs)
    const leaveLoginMs = resolveLoginLeaveTimeoutMs({
      targetTimeoutMs: target.loginLeaveTimeoutMs,
      loginTimeoutMs: timeoutMs,
    })
    const solveOptions = {
      timeoutMs: solveTimeoutMs,
      minDurationMs: target.sliderDragMinDurationMs ?? DEFAULT_SLIDER_DRAG_MIN_DURATION_MS,
      maxDurationMs: target.sliderDragMaxDurationMs ?? DEFAULT_SLIDER_DRAG_MAX_DURATION_MS,
    }
    for (let tryNo = 1; tryNo <= captchaTries; tryNo += 1) {
      await authorize()
      await user.fill(credential.username)
      await authorize()
      await resolved.password.fill(credential.password)
      if (resolved.totp && credential.totpSecret) {
        await authorize()
        const code = generateTotp(credential.totpSecret)
        await resolved.totp.fill(code)
      }
      const preChallenge = await waitForLoginChallenge(handle.basePage, target, Math.min(8_000, timeoutMs))
      if (preChallenge) {
        const outcome = await solveChallenge(handle.basePage, preChallenge, solveOptions)
        if (!outcome.solved) {
          lastSubmit = 'unsolved'
          await preChallenge.locators.image?.click().catch(() => undefined)
          await handle.basePage.waitForTimeout(400)
          continue
        }
      } else if (expectsLoginChallenge(target)) {
        lastSubmit = 'unsolved'
        continue
      }

      await resolved.submit.click()
      await handle.basePage.waitForTimeout(400)
      const postChallenge = await detectChallenge(handle.basePage, target.captcha)
      if (postChallenge) {
        const outcome = await solveChallenge(handle.basePage, postChallenge, solveOptions)
        if (!outcome.solved) {
          lastSubmit = 'unsolved'
          continue
        }
      }

      await handle.basePage.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {})

      if (credential.totpSecret) {
        const postTotp = await firstVisibleLoginLocator(handle.basePage, loginLocatorCandidates('totp', fields?.totp))
        if (postTotp && (await postTotp.isVisible().catch(() => false))) {
          await authorize()
          const code = generateTotp(credential.totpSecret)
          await postTotp.fill(code)
          const postSubmit = await firstVisibleLoginLocator(handle.basePage, loginLocatorCandidates('submit', fields?.submit))
          if (postSubmit && (await postSubmit.isVisible().catch(() => false))) {
            await postSubmit.click().catch(() => postTotp.press('Enter'))
          } else {
            await postTotp.press('Enter').catch(() => {})
          }
          await handle.basePage.waitForTimeout(400)
          await handle.basePage.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {})
        }
      }
      const leftLogin = await waitUntilLeftLogin(handle.basePage, loginUrl, target.entryUrl, leaveLoginMs)
      if (leftLogin || (await inspectAuthOnPage(handle.basePage, target)) === 'AUTHENTICATED') {
        return { authenticated: true, submit: 'authenticated' }
      }
      const pageText = await handle.basePage.locator('body').innerText().catch(() => '')
      const submitOutcome = classifyLoginSubmitText(pageText) ?? 'ambiguous'
      lastSubmit = submitOutcome
      if (submitOutcome === 'credential_failed' || submitOutcome === 'ambiguous') {
        return { authenticated: false, submit: submitOutcome }
      }
      const refresh = await detectChallenge(handle.basePage, target.captcha)
      if (shouldRetryLoginSubmit(submitOutcome, Boolean(refresh))) {
        await refresh?.locators.image?.click().catch(() => undefined)
        await handle.basePage.waitForTimeout(400)
        continue
      }
      return { authenticated: false, submit: submitOutcome }
    }
    return { authenticated: false, submit: lastSubmit }
  } catch (error) {
    // Authorization failure is terminal; it is not a wrong-password result.
    if (authorityRejected) throw error
    return { authenticated: false, submit: lastSubmit === 'unsolved' ? 'ambiguous' : lastSubmit }
  }
}

export async function submitLoginCredentials(
  handle: BrowserHandle,
  target: TargetAuthInfo,
  credential: { username: string; password: string; totpSecret?: string },
  timeoutMs = 30_000,
  beforeAction?: () => void | Promise<void>,
): Promise<boolean> {
  return (await attemptLoginCredentials(handle, target, credential, timeoutMs, beforeAction)).authenticated
}

/**
 * 提交后核验证件。刚登完常还停在 /login，无验证码时打开入口看 cookie，
 * 避免把已成功登录误判成失败。有验证码时只看当前页，避免刷新挑战。
 */
export async function confirmSubmittedLogin(
  handle: BrowserHandle,
  target: TargetAuthInfo,
  submitted: LoginAttemptResult,
): Promise<LoginAttemptResult> {
  if (submitted.authenticated) {
    if ((await probeAuth(handle, target)) === 'AUTHENTICATED') {
      return { authenticated: true, submit: 'authenticated' }
    }
    return { authenticated: false, submit: submitted.submit }
  }
  if ((await inspectAuthOnPage(handle.basePage, target)) === 'AUTHENTICATED') {
    return { authenticated: true, submit: 'authenticated' }
  }
  if (
    submitted.submit === 'ambiguous' &&
    !expectsLoginChallenge(target) &&
    (await probeAuth(handle, target)) === 'AUTHENTICATED'
  ) {
    return { authenticated: true, submit: 'authenticated' }
  }
  return submitted
}

export async function attemptLoginWithCredentials(
  handle: BrowserHandle,
  target: TargetAuthInfo,
  credential: { username: string; password: string; totpSecret?: string },
  beforeAction?: () => void | Promise<void>,
): Promise<LoginAttemptResult> {
  requireOccupancy('loginWithCredentials')
  const submitted = await attemptLoginCredentials(handle, target, credential, undefined, beforeAction)
  try {
    return await confirmSubmittedLogin(handle, target, submitted)
  } catch {
    return { authenticated: false, submit: submitted.submit === 'authenticated' ? 'ambiguous' : submitted.submit }
  }
}

export async function loginWithCredentials(
  handle: BrowserHandle,
  target: TargetAuthInfo,
  credential: { username: string; password: string; totpSecret?: string },
  beforeAction?: () => void | Promise<void>,
): Promise<boolean> {
  requireOccupancy('loginWithCredentials')
  return (await attemptLoginWithCredentials(handle, target, credential, beforeAction)).authenticated
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
  framePath: FrameStep[] = [],
  timeoutMs = 8_000,
): Promise<FrameResolve> {
  // 整条 FramePath 共用一个截止时间：四层路径不该把预算乘以四。
  const deadline = Date.now() + timeoutMs
  let current: Frame = page.mainFrame()
  const trail: string[] = ['main']
  for (const step of framePath ?? []) {
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

export async function countCandidateNow(
  scope: Page | Frame | Locator,
  candidate: LocatorCandidate,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted()
  try {
    return await locatorForCandidate(scope, candidate).count()
  } catch (error) {
    if (isSurfaceLost(error)) throw new SurfaceLostError(error instanceof Error ? error.message : '页面上下文失效')
    throw error
  }
}

export async function countCandidate(
  scope: Page | Frame | Locator,
  candidate: LocatorCandidate,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = 0
  while (Date.now() <= deadline) {
    last = await countCandidateNow(scope, candidate, signal)
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
  const installed = installedScopeAllows(page.context(), resolved.href)
  if (installed === false) {
    return { outOfScope: true, href: resolved.href }
  }
  await page.goto(resolved.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  // SPA shells often reach DOMContentLoaded before their first usable paint.
  // A following AI step would otherwise see only the shell background and
  // conclude that a visible control is absent. Bound the wait so pages with
  // intentionally empty or canvas-only bodies still retain navigation semantics.
  if (typeof page.waitForFunction === 'function') {
    await page.waitForFunction(
      () => {
        const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document
        const text = doc?.body?.innerText?.replace(/\s+/g, ' ').trim() ?? ''
        return text.length > 0 && !/^(loading\.{0,3}|加载中[.。…]*)$/i.test(text)
      },
      undefined,
      { timeout: 10_000, polling: 250 },
    ).catch(() => undefined)
  }
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

export async function readLocatorMany(
  locator: Locator,
  as: 'text' | 'value' | 'attribute',
  attribute?: string,
): Promise<string[]> {
  const elements = await locator.all()
  const results: string[] = []
  for (const el of elements) {
    if (as === 'value') {
      results.push(await el.inputValue({ timeout: 5_000 }))
    } else if (as === 'attribute') {
      results.push((await el.getAttribute(attribute ?? '', { timeout: 5_000 })) ?? '')
    } else {
      results.push(await el.innerText({ timeout: 5_000 }))
    }
  }
  return results
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

export type ScreenshotPageOptions = {
  fullPage?: boolean
  selectors?: readonly string[]
}

export function screenshotMaskLocators(page: Page, selectors: readonly string[] = []) {
  const locators = [page.locator('input[type="password"]')]
  for (const selector of selectors) {
    locators.push(page.locator(selector))
    locators.push(page.locator('iframe').contentFrame().locator(selector))
  }
  return locators
}

export async function screenshotPage(page: Page, options?: ScreenshotPageOptions): Promise<Buffer> {
  return page.screenshot({
    type: 'png',
    fullPage: options?.fullPage ?? false,
    mask: screenshotMaskLocators(page, options?.selectors ?? []),
  })
}

export async function pageHasSensitiveContent(
  page: Page,
  selectors: readonly string[] = [],
): Promise<boolean> {
  try {
    // A failed inspection is unknown, not proof that the page is safe to
    // disclose to another model or consumer of the screenshot metadata.
    if (pageClosed(page)) return true
    const pwLoc = page.locator('input[type="password"]')
    const pwCount = await pwLoc.count()
    for (let i = 0; i < pwCount; i++) {
      if (await pwLoc.nth(i).isVisible()) return true
    }
    for (const selector of selectors) {
      if (!selector) continue
      const loc = page.locator(selector)
      const count = await loc.count()
      for (let i = 0; i < count; i++) {
        if (await loc.nth(i).isVisible()) return true
      }
    }
  } catch {
    return true
  }
  return false
}

export function pageClosed(page: Page): boolean {
  return page.isClosed()
}

export async function uploadToLocator(
  page: Page,
  locator: Locator,
  files: Array<{
    name: string
    mimeType: string
    bufferBase64?: string
    localPath?: string
    byteSize: number
    sha256: string
  }>,
): Promise<{ method: 'dom_direct' | 'file_chooser'; count: number }> {
  requireOccupancy('uploadToLocator')

  const isDirect = await locator
    .evaluate((el: any) => el.tagName === 'INPUT' && el.type === 'file')
    .catch(() => false)
  let inputLocator = locator
  if (!isDirect) {
    const nested = locator.locator('input[type="file"]').first()
    if ((await nested.count().catch(() => 0)) > 0) {
      inputLocator = nested
    } else {
      const parentCandidate = locator.locator('xpath=..')
      const isTopContainer = await parentCandidate
        .evaluate((el: any) => el.tagName === 'FORM' || el.tagName === 'BODY' || el.tagName === 'HTML')
        .catch(() => false)
      if (!isTopContainer) {
        const candidateInput = parentCandidate.locator('input[type="file"]').first()
        if ((await candidateInput.count().catch(() => 0)) > 0) {
          inputLocator = candidateInput
        }
      }
    }
  }

  const hasFileInput = isDirect || inputLocator !== locator

  if (hasFileInput) {
    const isMultiple = await inputLocator
      .evaluate((el: any) => el.hasAttribute('multiple'))
      .catch(() => false)
    if (!isMultiple && files.length > 1) {
      throw new Error('UPLOAD_TARGET_SINGLE_ONLY: 目标输入框不支持多文件同时上传，但步骤配置了多个文件')
    }
  }

  const allPaths = files.every((f) => Boolean(f.localPath))
  const payloads = allPaths
    ? files.map((f) => f.localPath!)
    : files.map((f) => ({
        name: f.name,
        mimeType: f.mimeType,
        buffer: Buffer.from(f.bufferBase64 ?? '', 'base64'),
      }))

  if (hasFileInput) {
    await inputLocator.setInputFiles(payloads as any, { timeout: 5_000 })
    return { method: 'dom_direct', count: files.length }
  }

  const isDisabled = await locator
    .evaluate(
      (el: any) =>
        Boolean(el.disabled) ||
        el.getAttribute?.('aria-disabled') === 'true',
    )
    .catch(() => false)
  if (isDisabled) {
    throw new Error('UPLOAD_PRECONDITION_FAILED: 上传触发按钮当前处于禁用状态，无法打开文件选择框')
  }

  if (page) {
    ;(page as any).__cairnFileChooserOpen = true
  }
  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 3_000 }),
      locator.click({ timeout: 2_000 }),
    ])
    if (!fileChooser.isMultiple() && files.length > 1) {
      throw new Error('UPLOAD_TARGET_SINGLE_ONLY: 唤起的文件选择框不支持多文件同时上传，但步骤配置了多个文件')
    }
    await fileChooser.setFiles(payloads as any)
    return { method: 'file_chooser', count: files.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UPLOAD_TARGET_SINGLE_ONLY')) throw err
    if (msg.includes('Timeout') || msg.includes('timeout')) {
      throw new Error('UPLOAD_NO_FILE_INPUT: 未找到文件输入元素，点击目标也没有唤起文件选择')
    }
    throw err
  } finally {
    if (page) {
      ;(page as any).__cairnFileChooserOpen = false
    }
  }
}

export type { Locator, Frame, Page }
