import {
  appendSessionEvent,
  listRecentAuthEvents,
  loadTargetForExecution,
  readLiveSessionAuth,
  type SessionRecord,
} from '@cairn/db'
import {
  LANDING_SETTLE_DISMISS_WAIT_MS,
  LANDING_SETTLE_OVERLAY_POLL_MS,
  LANDING_SETTLE_QUIET_MS,
  LANDING_SETTLE_URL_STABLE_MS,
  classifyDismissLabel,
  isAppShellOverlay,
  isInterstitialAuthPath,
  isUnusableSettleUrl,
  needsLandingSettleCatchUp,
  platformSessionAuthSchema,
  resolveLandingSettleConfig,
  skippedLandingSettle,
  type LandingSettleResult,
  type PlatformSessionAuth,
  type SessionGrant,
  type TargetLoginFields,
} from '@cairn/shared'
import type { Frame, Locator, Page } from 'playwright'
import { detectChallenge } from './captcha/index.js'
import { originAllowed } from './page-identity.js'
import { inspectAuthOnPage, loginUrlLooksPending, type TargetAuthInfo } from './runtime.js'
import type { SessionManagerContext } from './session-live.js'

export type SettlePageTarget = TargetAuthInfo & {
  landingSettleMode?: 'default' | 'off' | null
  landingSettleTimeoutMs?: number | null
  allowedOrigins?: string[]
}

export type SettleAuthenticatedLandingInput = {
  page: Page
  target: SettlePageTarget
  sessionAuth: Pick<
    PlatformSessionAuth,
    'loginTimeoutMs' | 'landingSettleBudgetMs' | 'landingSettleWatchMs' | 'landingSettleMaxDismissals'
  >
  alreadyOpenedEntry?: boolean
  lastNavigationMethod?: string
  fileChooserOpen?: boolean
  downloadPending?: boolean
  catchUp?: boolean
  inputAccepting?: boolean
  identityMismatch?: boolean
}

class SettleBudget {
  constructor(private readonly deadline: number) {}

  remaining(): number {
    return Math.max(0, this.deadline - Date.now())
  }

  expired(): boolean {
    return Date.now() >= this.deadline
  }

  async wait(page: Page, ms: number): Promise<boolean> {
    const slice = Math.min(ms, this.remaining())
    if (slice <= 0) return false
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(slice)
    else await new Promise((resolve) => setTimeout(resolve, slice))
    return true
  }
}

function pageOrigin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function urlInScope(url: string, entryUrl: string, allowedOrigins?: string[]): boolean {
  if (allowedOrigins && allowedOrigins.length > 0) return originAllowed(url, allowedOrigins)
  const current = pageOrigin(url)
  const entry = pageOrigin(entryUrl)
  return Boolean(current && entry && current === entry)
}

async function passwordFieldVisible(page: Page, target: SettlePageTarget): Promise<boolean> {
  const specified = target.loginFields?.password
  if (specified) {
    const locator =
      specified.by === 'id'
        ? page.locator(`#${specified.value}`)
        : specified.by === 'name'
          ? page.locator(`[name="${specified.value}"]`)
          : page.locator(specified.value)
    if (await locator.first().isVisible().catch(() => false)) return true
  }
  return page.locator('input[type="password"]').first().isVisible().catch(() => false)
}

async function otpInputVisible(page: Page): Promise<boolean> {
  if (await page.locator('input[autocomplete="one-time-code"]').first().isVisible().catch(() => false)) {
    return true
  }
  return page
    .getByRole('textbox', { name: /otp|mfa|totp|authenticator|一次性|验证码/i })
    .first()
    .isVisible()
    .catch(() => false)
}

async function accountPickerVisible(page: Page): Promise<boolean> {
  return page
    .getByRole('heading', { name: /选择账号|choose an account/i })
    .first()
    .isVisible()
    .catch(() => false)
}

function sameOriginFrames(page: Page): Frame[] {
  const origin = pageOrigin(page.url())
  if (!origin) return [page.mainFrame()]
  return page.frames().filter((frame) => {
    try {
      return new URL(frame.url()).origin === origin
    } catch {
      return false
    }
  })
}

async function overlayContainsAuthInputs(overlay: Locator): Promise<boolean> {
  if (await overlay.locator('input[type="password"]').first().isVisible().catch(() => false)) return true
  return overlay.locator('input[autocomplete="one-time-code"]').first().isVisible().catch(() => false)
}

async function overlayButtonNames(overlay: Locator): Promise<string[]> {
  const buttons = overlay.getByRole('button')
  const count = await buttons.count().catch(() => 0)
  const names: string[] = []
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index)
    if (!(await button.isVisible().catch(() => false))) continue
    if (await button.isDisabled().catch(() => false)) continue
    const label =
      (await button.getAttribute('aria-label').catch(() => null))?.trim() ||
      (await button.innerText().catch(() => '')).trim()
    if (label) names.push(label)
  }
  return names
}

async function isVisibleOverlay(locator: Locator): Promise<boolean> {
  if (!(await locator.isVisible().catch(() => false))) return false
  const box = await locator.boundingBox().catch(() => null)
  return Boolean(box && box.width > 0 && box.height > 0)
}

async function collectOverlays(page: Page): Promise<Locator[]> {
  const found: Locator[] = []
  for (const frame of sameOriginFrames(page)) {
    for (const role of ['dialog', 'alertdialog'] as const) {
      const group = frame.getByRole(role)
      const count = await group.count().catch(() => 0)
      for (let index = 0; index < count; index += 1) {
        const item = group.nth(index)
        if (await isVisibleOverlay(item)) found.push(item)
      }
    }
    const extra = frame.locator('[aria-modal="true"]:not([role="dialog"]):not([role="alertdialog"])')
    const extraCount = await extra.count().catch(() => 0)
    for (let index = 0; index < extraCount; index += 1) {
      const item = extra.nth(index)
      if (await isVisibleOverlay(item)) found.push(item)
    }
  }
  return found.reverse()
}

async function waitUrlStable(page: Page, budget: SettleBudget, windowMs: number): Promise<boolean> {
  let last = page.url()
  let since = Date.now()
  while (!budget.expired()) {
    if (!(await budget.wait(page, 50))) break
    const current = page.url()
    if (current !== last) {
      last = current
      since = Date.now()
    } else if (Date.now() - since >= windowMs) {
      return true
    }
  }
  return false
}

async function dismissOverlay(
  page: Page,
  overlay: Locator,
  budget: SettleBudget,
): Promise<boolean> {
  if (typeof page.keyboard?.press === 'function') {
    await page.keyboard.press('Escape').catch(() => undefined)
    await budget.wait(page, LANDING_SETTLE_DISMISS_WAIT_MS)
    if (!(await overlay.isVisible().catch(() => false))) return true
  }
  const names = await overlayButtonNames(overlay)
  const allowName = names.find((name) => classifyDismissLabel(name) === 'allow')
  if (!allowName) return false
  const button = overlay.getByRole('button', { name: allowName }).first()
  const timeout = Math.max(200, Math.min(1_500, budget.remaining()))
  try {
    await button.click({ timeout })
  } catch {
    await button.click({ timeout, force: true }).catch(() => undefined)
  }
  await budget.wait(page, LANDING_SETTLE_DISMISS_WAIT_MS)
  if (!(await overlay.isVisible().catch(() => false))) return true
  try {
    await button.click({ timeout })
  } catch {
    await button.click({ timeout, force: true }).catch(() => undefined)
  }
  await budget.wait(page, LANDING_SETTLE_DISMISS_WAIT_MS)
  return !(await overlay.isVisible().catch(() => false))
}

export async function settleAuthenticatedLanding(
  input: SettleAuthenticatedLandingInput,
): Promise<LandingSettleResult> {
  const catchUp = Boolean(input.catchUp)
  if (input.identityMismatch) return skippedLandingSettle('mismatch', catchUp)
  if (input.inputAccepting) return skippedLandingSettle('input_accepting', catchUp)
  const resolved = resolveLandingSettleConfig({
    mode: input.target.landingSettleMode,
    targetTimeoutMs: input.target.landingSettleTimeoutMs,
    platformBudgetMs: input.sessionAuth.landingSettleBudgetMs,
    platformWatchMs: input.sessionAuth.landingSettleWatchMs,
    platformMaxDismissals: input.sessionAuth.landingSettleMaxDismissals,
    loginTimeoutMs: input.sessionAuth.loginTimeoutMs,
  })
  if (resolved.mode === 'off') return skippedLandingSettle('mode_off', catchUp)
  if (input.fileChooserOpen) return skippedLandingSettle('file_chooser', catchUp)
  if (input.downloadPending) return skippedLandingSettle('download', catchUp)
  if (input.lastNavigationMethod && input.lastNavigationMethod !== 'GET') {
    return skippedLandingSettle('unsafe_navigation', catchUp)
  }

  const page = input.page
  if (!page || page.isClosed?.() || typeof page.getByRole !== 'function') {
    return skippedLandingSettle('url_unusable', catchUp)
  }
  let url = ''
  try {
    url = page.url()
  } catch {
    return skippedLandingSettle('url_unusable', catchUp)
  }
  if (isUnusableSettleUrl(url)) return skippedLandingSettle('url_unusable', catchUp)
  if (!urlInScope(url, input.target.entryUrl, input.target.allowedOrigins)) {
    return skippedLandingSettle('out_of_scope', catchUp)
  }

  const loginLike = loginUrlLooksPending(url, input.target)
  if (await passwordFieldVisible(page, input.target)) return skippedLandingSettle('password_visible', catchUp)
  if (isInterstitialAuthPath(url, input.target.entryUrl)) return skippedLandingSettle('interstitial', catchUp)
  if (await otpInputVisible(page)) return skippedLandingSettle('interstitial', catchUp)
  if (await accountPickerVisible(page)) return skippedLandingSettle('interstitial', catchUp)
  const challenge = await detectChallenge(page, input.target.captcha).catch(() => null)
  if (challenge) return skippedLandingSettle('interstitial', catchUp)
  if (loginLike && input.alreadyOpenedEntry) return skippedLandingSettle('login_page', catchUp)

  const budget = new SettleBudget(Date.now() + resolved.budgetMs)
  const result: LandingSettleResult = {
    didNavigate: false,
    didReload: false,
    overlaysSeen: 0,
    overlaysDismissed: 0,
    residualOverlay: false,
    catchUp,
  }

  try {
    if (typeof page.waitForLoadState === 'function') {
      await page
        .waitForLoadState('domcontentloaded', { timeout: Math.min(3_000, budget.remaining()) })
        .catch(() => undefined)
    }
    const stable = await waitUrlStable(page, budget, LANDING_SETTLE_URL_STABLE_MS)
    const stillLoginLike = loginUrlLooksPending(page.url(), input.target)
    if (!input.alreadyOpenedEntry && stable) {
      if (!stillLoginLike) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(8_000, budget.remaining()) })
        result.didReload = true
      } else {
        await page.goto(input.target.entryUrl, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(8_000, budget.remaining()),
        })
        result.didNavigate = true
      }
    }
    await budget.wait(page, LANDING_SETTLE_QUIET_MS)
    if (
      (await passwordFieldVisible(page, input.target)) ||
      loginUrlLooksPending(page.url(), input.target)
    ) {
      if ((await inspectAuthOnPage(page, input.target)) !== 'AUTHENTICATED') {
        result.authLost = true
        return result
      }
      if (loginUrlLooksPending(page.url(), input.target)) return { ...result, skippedReason: 'login_page' }
    }

    const watchDeadline = Date.now() + resolved.watchMs
    let overlays: Locator[] = []
    while (!budget.expired() && Date.now() < watchDeadline) {
      overlays = await collectOverlays(page)
      if (overlays.length > 0) break
      await budget.wait(page, LANDING_SETTLE_OVERLAY_POLL_MS)
    }
    if (overlays.length === 0) overlays = await collectOverlays(page)

    const viewport = typeof page.viewportSize === 'function' ? page.viewportSize() : null
    for (const overlay of overlays) {
      if (budget.expired() || result.overlaysDismissed >= resolved.maxDismissals) break
      if (!(await isVisibleOverlay(overlay))) continue
      if (await overlayContainsAuthInputs(overlay)) continue
      const names = await overlayButtonNames(overlay)
      const hasAllowButton = names.some((name) => classifyDismissLabel(name) === 'allow')
      const box = await overlay.boundingBox().catch(() => null)
      if (
        box &&
        viewport &&
        isAppShellOverlay({
          width: box.width,
          height: box.height,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          hasAllowButton,
        })
      ) {
        continue
      }
      result.overlaysSeen += 1
      if (await dismissOverlay(page, overlay, budget)) result.overlaysDismissed += 1
    }
    const remaining = await collectOverlays(page)
    result.residualOverlay = remaining.length > 0
    return result
  } catch {
    return { ...result, residualOverlay: result.overlaysSeen > result.overlaysDismissed }
  }
}

export type SettleOccupiedLandingInput = {
  session: SessionRecord
  grant?: SessionGrant | null
  page?: Page | null
  trigger: 'after_login' | 'catch_up' | 'manual'
  alreadyOpenedEntry?: boolean
  operationId?: string
  runId?: string
}

function loginFieldsOf(value: unknown): TargetLoginFields | null {
  if (!value || typeof value !== 'object') return null
  return value as TargetLoginFields
}

export async function settleOccupiedLanding(
  this: SessionManagerContext,
  input: SettleOccupiedLandingInput,
): Promise<LandingSettleResult> {
  const live = this.lives.get(input.session.id)
  if (live?.inputAccepting) return skippedLandingSettle('input_accepting', input.trigger === 'catch_up')
  if (input.session.identityState === 'MISMATCH') {
    return skippedLandingSettle('mismatch', input.trigger === 'catch_up')
  }

  const liveAuth = await readLiveSessionAuth(this.dbHandle).catch(() => null)
  const parsed = liveAuth ? platformSessionAuthSchema.safeParse(liveAuth.sessionAuth) : null
  if (!liveAuth || !parsed?.success) {
    const skipped = skippedLandingSettle('config_unreadable', input.trigger === 'catch_up')
    await persistLandingSettled.call(this, input, skipped, null)
    return skipped
  }

  const events = await listRecentAuthEvents(this.dbHandle, {
    sessionId: input.session.id,
    limit: 80,
  }).catch(() => [])
  const catchUpNeeded = needsLandingSettleCatchUp(events, input.session.id)
  if (input.trigger === 'catch_up' && !catchUpNeeded) return skippedLandingSettle('already_settled')
  const catchUp = input.trigger === 'catch_up' || (input.trigger === 'manual' && catchUpNeeded)

  const targetRow = await loadTargetForExecution(this.dbHandle, input.session.targetId).catch(() => null)
  if (!targetRow) {
    const skipped = skippedLandingSettle('config_unreadable', catchUp)
    await persistLandingSettled.call(this, input, skipped, liveAuth.revision)
    return skipped
  }

  const page =
    input.page ??
    (input.grant ? this.pageForGrant(input.grant) : undefined) ??
    (live
      ? this.ensureRunPage(live, input.runId ?? input.operationId ?? input.session.id, input.grant?.leaseId)
          .page
      : undefined) ??
    live?.handle.basePage
  if (!page) {
    const skipped = skippedLandingSettle('url_unusable', catchUp)
    await persistLandingSettled.call(this, input, skipped, liveAuth.revision)
    return skipped
  }

  const leaseId =
    input.grant?.leaseId ??
    [...this.leaseToSession.entries()].find(([, sessionId]) => sessionId === input.session.id)?.[0]
  if (leaseId) await this.renew(leaseId).catch(() => 'lost')

  const managed = live
    ? [...live.pages.values()].find((entry) => entry.page === page)
    : undefined
  const result = await settleAuthenticatedLanding({
    page,
    target: {
      entryUrl: targetRow.entryUrl,
      loginUrl: targetRow.loginUrl,
      loginFields: loginFieldsOf(targetRow.loginFields),
      captcha: targetRow.captcha ?? null,
      landingSettleMode: targetRow.landingSettleMode,
      landingSettleTimeoutMs: targetRow.landingSettleTimeoutMs,
      allowedOrigins: live?.allowedOrigins,
    },
    sessionAuth: parsed.data,
    alreadyOpenedEntry: input.alreadyOpenedEntry,
    lastNavigationMethod: managed?.lastNavigationMethod,
    fileChooserOpen: (managed as any)?.fileChooserOpen ?? (page as any)?.__cairnFileChooserOpen,
    downloadPending: (managed as any)?.downloadPending ?? (page as any)?.__cairnDownloadPending,
    catchUp,
    inputAccepting: live?.inputAccepting,
    identityMismatch: false,
  }).catch(() => skippedLandingSettle('url_unusable', catchUp))

  await persistLandingSettled.call(this, input, result, liveAuth.revision)
  return result
}

async function persistLandingSettled(
  this: SessionManagerContext,
  input: SettleOccupiedLandingInput,
  result: LandingSettleResult,
  revision: number | null,
): Promise<void> {
  if (result.skippedReason === 'already_settled') return
  try {
    await appendSessionEvent(this.dbHandle, {
      key: { targetId: input.session.targetId, targetAccountId: input.session.targetAccountId },
      type: 'auth.landing_settled',
      sessionId: input.session.id,
      generation: input.session.generation,
      operationId: input.operationId,
      runId: input.runId,
      payload: {
        ...result,
        platformConfigRevision: revision,
      },
    })
  } catch {
    // 测试夹具或瞬时写失败不得推翻已登录
  }
}

export function openedEntryDuringVerify(beforeUrl: string, afterUrl: string, entryUrl: string): boolean {
  if (!afterUrl || beforeUrl === afterUrl) return false
  try {
    const after = new URL(afterUrl)
    const entry = new URL(entryUrl)
    return after.origin === entry.origin && after.pathname === entry.pathname
  } catch {
    return false
  }
}

/**
 * 批次项隔离与状态复位 (DC-08, DC-09)
 * 抑制未关闭弹窗，并复位至起始页面
 */
export async function settleItemBoundary(
  page: Page,
  options?: {
    startUrl?: string
    suppressBlockingDialogs?: boolean
  },
): Promise<void> {
  if (page.isClosed()) return

  if (options?.suppressBlockingDialogs !== false) {
    const onDialog = (dialog: any) => {
      dialog.dismiss().catch(() => {})
    }
    page.on('dialog', onDialog)
    try {
      await page.keyboard.press('Escape').catch(() => {})
      const modalButtons = page.locator(
        '[role="dialog"] button, [role="alertdialog"] button, [aria-modal="true"] button',
      )
      const count = await modalButtons.count().catch(() => 0)
      for (let i = 0; i < Math.min(count, 3); i++) {
        const btn = modalButtons.nth(i)
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 500 }).catch(() => {})
        }
      }
    } catch {
      // ignore DOM cleanup error
    } finally {
      page.off?.('dialog', onDialog)
    }
  }

  if (options?.startUrl) {
    try {
      if (page.url() !== options.startUrl) {
        await page.goto(options.startUrl, { timeout: 10_000, waitUntil: 'domcontentloaded' }).catch(() => {})
      }
    } catch {
      // ignore navigation error
    }
  }
}

