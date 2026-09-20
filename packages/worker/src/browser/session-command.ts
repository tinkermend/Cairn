import { appendRunEvents, recordInlineLogEvidence, setSessionProbe } from '@cairn/db'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isSideEffectBrowserCommand,
  requiredScreenshotRole,
  resolveEvidencePolicy,
  shouldCaptureEvidence,
  type BrowserCommand,
  type BrowserCommandEvidence,
  type BrowserCommandResult,
  type PageRef,
  type ScreenshotRole,
  authGateClosedError,
  type RunSnapshot,
  type SessionGrant
} from '@cairn/shared'
import type { Page } from 'playwright'
import { GuardError } from './guard'
import {
  OccupancyRequiredError,
  closePage,
  waitForPopupsFrom,
  screenshotPage
} from './runtime'
import { assertPageTargetScope, TargetScopeError } from './target-scope'
import { executeOnPage } from './surface'
import { handoffMessage } from './managed-helpers'
import { createManagedPage, pageRefFor, pickPopupHandoff, type ManagedPageEntry } from './page-identity'
import { type LiveHandle, type SessionManagerContext } from './session-live.js'

export function assertCommand(this: SessionManagerContext, leaseId: string): SessionGrant {
    return this.guard.assertHeld(leaseId)
  }

export async function withManagedPage<T>(this: SessionManagerContext, 
    grant: SessionGrant,
    evidence: BrowserCommandEvidence | undefined,
    fn: (page: import('playwright').Page) => Promise<T>,
    failed: (value: T) => boolean = () => false,
  ): Promise<
    | {
        ok: true
        value: T
        screenshotBytes?: Buffer
        extraShots?: { role: ScreenshotRole; bytes: Buffer }[]
        faceRole?: ScreenshotRole
        tracePath?: string
      }
    | {
        ok: false
        error: Extract<BrowserCommandResult, { ok: false }>['error']
        screenshotBytes?: Buffer
        extraShots?: { role: ScreenshotRole; bytes: Buffer }[]
        faceRole?: ScreenshotRole
        tracePath?: string
      }
  > {
    try {
      this.guard.assertHeld(grant.leaseId, grant)
    } catch (error) {
      if (error instanceof GuardError) {
        return {
          ok: false,
          error: {
            code: 'SESSION_LEASE_LOST',
            category: 'INFRASTRUCTURE',
            retryable: false,
            safeMessage: error.message,
          },
        }
      }
      throw error
    }
    return this.withHeldOccupancy(grant.leaseId, grant, () =>
      this.runManagedPage(grant, evidence, fn, failed),
    )
  }

export async function runManagedPage<T>(this: SessionManagerContext, 
    grant: SessionGrant,
    evidence: BrowserCommandEvidence | undefined,
    fn: (page: import('playwright').Page) => Promise<T>,
    failed: (value: T) => boolean,
  ): Promise<
    | {
        ok: true
        value: T
        screenshotBytes?: Buffer
        extraShots?: { role: ScreenshotRole; bytes: Buffer }[]
        faceRole?: ScreenshotRole
        pageRef?: PageRef
        tracePath?: string
      }
    | {
        ok: false
        error: Extract<BrowserCommandResult, { ok: false }>['error']
        screenshotBytes?: Buffer
        extraShots?: { role: ScreenshotRole; bytes: Buffer }[]
        faceRole?: ScreenshotRole
        pageRef?: PageRef
        tracePath?: string
      }
  > {
    const live = this.lives.get(this.leaseToSession.get(grant.leaseId) ?? grant.sessionId)
    if (live?.autoInputClosed) {
      return {
        ok: false,
        error: {
          code: 'SESSION_LEASE_LOST',
          category: 'INFRASTRUCTURE',
          retryable: false,
          safeMessage: '运行正在等待认证，自动输入已关闭',
        },
      }
    }
    const page = this.pageForGrant(grant)
    if (!page) {
      return {
        ok: false,
        error: {
          code: 'SESSION_NOT_CLAIMABLE',
          category: 'INFRASTRUCTURE',
          retryable: true,
          safeMessage: '本进程没有该租约对应的页面',
        },
      }
    }
    const tracing = this.tracingByLease.get(grant.leaseId) === true
    const contextTracing = page.context().tracing
    const tracePath =
      tracing && evidence ? join(tmpdir(), `cairn-trace-${evidence.attemptId}.zip`) : undefined
    if (tracePath && evidence) {
      await contextTracing.startChunk({ title: evidence.attemptId })
    }
    const shotOpts = {
      fullPage: (evidence?.screenshotViewport ?? 'full_page') === 'full_page',
      selectors: evidence?.sensitiveSelectors ?? [],
    }
    const extraShots: { role: ScreenshotRole; bytes: Buffer }[] = []
    const startPageId = live?.currentPageIdByLease.get(grant.leaseId)
    if (
      evidence &&
      evidence.commandType &&
      isSideEffectBrowserCommand(evidence.commandType) &&
      shouldCaptureEvidence(evidence.screenshot ?? 'on_failure', false)
    ) {
      const before = await screenshotPage(page, shotOpts).catch(() => undefined)
      if (before) extraShots.push({ role: 'before_action', bytes: before })
    }
    try {
      assertPageTargetScope(page)
      const value = await fn(page)
      assertPageTargetScope(page)
      const current = this.pageForGrant(grant) ?? page
      const currentId = live?.currentPageIdByLease.get(grant.leaseId)
      const currentEntry = currentId ? live?.pages.get(currentId) : undefined
      if (currentEntry?.retarget) await currentEntry.retarget.catch(() => undefined)
      const pageRef =
        live && currentEntry ? pageRefFor(live.sessionId, live.generation, currentEntry) : undefined
      const failedNow = failed(value)
      const wantShot = evidence
        ? shouldCaptureEvidence(evidence.screenshot ?? 'on_failure', failedNow)
        : failedNow
      const faceRole = requiredScreenshotRole({
        failed: failedNow,
        commandType: evidence?.commandType,
      })
      if (wantShot && startPageId && currentId && startPageId !== currentId) {
        const handoff = await screenshotPage(current, shotOpts).catch(() => undefined)
        if (handoff) extraShots.push({ role: 'handoff', bytes: handoff })
      }
      const screenshotBytes = wantShot ? await screenshotPage(current, shotOpts).catch(() => undefined) : undefined
      return { ok: true, value, screenshotBytes, extraShots, faceRole, pageRef, tracePath }
    } catch (error) {
      if (error instanceof TargetScopeError) return { ok: false, error: { code: error.code, category: 'VALIDATION', retryable: false, safeMessage: error.message } }
      if (error instanceof OccupancyRequiredError) {
        return {
          ok: false,
          error: {
            code: 'SESSION_LEASE_LOST',
            category: 'INFRASTRUCTURE',
            retryable: false,
            safeMessage: error.message,
          },
        }
      }
      const current = this.pageForGrant(grant) ?? page
      const errorPageId = live?.currentPageIdByLease.get(grant.leaseId)
      const errorEntry = errorPageId ? live?.pages.get(errorPageId) : undefined
      const screenshotBytes = evidence
        ? await screenshotPage(current, shotOpts).catch(() => undefined)
        : undefined
      if (error instanceof GuardError) {
        return {
          ok: false,
          error: {
            code: 'SESSION_LEASE_LOST',
            category: 'INFRASTRUCTURE',
            retryable: false,
            safeMessage: error.message,
          },
          screenshotBytes,
          extraShots,
          faceRole: 'on_error',
          pageRef:
            live && errorEntry ? pageRefFor(live.sessionId, live.generation, errorEntry) : undefined,
          tracePath,
        }
      }
      throw error
    } finally {
      if (tracePath) {
        await contextTracing.stopChunk({ path: tracePath }).catch(() => undefined)
      }
    }
  }

export async function execute(this: SessionManagerContext, 
    grant: SessionGrant,
    command: BrowserCommand,
    signal?: AbortSignal,
    evidence?: BrowserCommandEvidence,
  ): Promise<
    BrowserCommandResult & {
      screenshotBytes?: Buffer
      extraShots?: { role: ScreenshotRole; bytes: Buffer }[]
      faceRole?: ScreenshotRole
      pageRef?: PageRef
      tracePath?: string
    }
  > {
    if (this.authGateClosed.has(grant.leaseId)) {
      return { ok: false, error: authGateClosedError('not_dispatched') }
    }
    const scoped = await this.withManagedPage(
      grant,
      evidence ? { ...evidence, commandType: evidence.commandType ?? command.type } : undefined,
      (page) => this.runSurfaceCommand(grant, page, command, signal, evidence),
      (result) => !result.ok,
    )
    const authClosed = await this.observeInRunAuth(grant, 'dispatched', signal)
    if (authClosed) {
      return {
        ok: false,
        error: authClosed,
        screenshotBytes: scoped.screenshotBytes,
        extraShots: scoped.extraShots,
        faceRole: scoped.faceRole,
        pageRef: scoped.pageRef,
        tracePath: scoped.tracePath,
      }
    }
    if (!scoped.ok) {
      return {
        ok: false,
        error: scoped.error,
        screenshotBytes: scoped.screenshotBytes,
        extraShots: scoped.extraShots,
        faceRole: scoped.faceRole,
        pageRef: scoped.pageRef,
        tracePath: scoped.tracePath,
      }
    }
    return {
      ...scoped.value,
      screenshotBytes: scoped.screenshotBytes,
      extraShots: scoped.extraShots,
      faceRole: scoped.faceRole,
      pageRef: scoped.pageRef,
      tracePath: scoped.tracePath,
    }
  }

export async function invalidate(this: SessionManagerContext, grant: SessionGrant, reason: string): Promise<void> {
    const sessionId = this.leaseToSession.get(grant.leaseId) ?? grant.sessionId
    await setSessionProbe(this.dbHandle, {
      sessionId,
      ...this.ownerScope(),
      health: 'UNHEALTHY',
    }).catch(() => undefined)
    await this.close(sessionId, reason).catch(() => undefined)
  }

export async function startTracingForLease(this: SessionManagerContext, leaseId: string, sessionId: string, run: RunSnapshot): Promise<void> {
    const policy = resolveEvidencePolicy(run.evidencePolicy)
    if (policy.trace === 'off') {
      this.tracingByLease.set(leaseId, false)
      return
    }
    const live = this.lives.get(sessionId)
    if (!live) {
      this.tracingByLease.set(leaseId, false)
      return
    }
    const tracing = live.handle.context.tracing
    if (!tracing?.start) {
      this.tracingByLease.set(leaseId, false)
      return
    }
    await tracing.start({ screenshots: true, snapshots: true })
    this.tracingByLease.set(leaseId, true)
  }

export async function stopTracingForLease(this: SessionManagerContext, leaseId: string, sessionId: string | undefined): Promise<void> {
    const enabled = this.tracingByLease.get(leaseId)
    this.tracingByLease.delete(leaseId)
    if (!enabled || !sessionId) return
    const live = this.lives.get(sessionId)
    if (!live) return
    await live.handle.context.tracing.stop().catch(() => undefined)
  }

export function pageForGrant(this: SessionManagerContext, grant: SessionGrant) {
    try {
      this.guard.assertHeld(grant.leaseId, grant)
    } catch {
      return undefined
    }
    const sessionId = this.leaseToSession.get(grant.leaseId) ?? grant.sessionId
    const live = this.lives.get(sessionId)
    if (!live) return undefined
    const runId = this.leaseToRun.get(grant.leaseId)
    const pageId =
      live.currentPageIdByLease.get(grant.leaseId) ?? (runId ? live.currentPageIdByRun.get(runId) : undefined)
    const current = pageId ? live.pages.get(pageId)?.page : undefined
    return current ?? live.runPages.get(grant.leaseId) ?? live.lastPage ?? live.handle.basePage
  }

export async function runSurfaceCommand(this: SessionManagerContext, 
    grant: SessionGrant,
    page: import('playwright').Page,
    command: BrowserCommand,
    signal?: AbortSignal,
    evidence?: BrowserCommandEvidence,
  ): Promise<BrowserCommandResult> {
    if (command.type !== 'click' || command.pageAfter !== 'popup') {
      return executeOnPage(page, command, signal)
    }
    let clickResult: BrowserCommandResult = { ok: false, error: { code: 'PAGE_HANDOFF_NO_POPUP', category: 'EXECUTOR', retryable: false, safeMessage: '点击未完成' } }
    const popped = await waitForPopupsFrom(page, async () => {
      clickResult = await executeOnPage(page, { ...command, pageAfter: 'same' }, signal)
    })
    if (!clickResult.ok) return clickResult
    const sessionId = this.leaseToSession.get(grant.leaseId) ?? grant.sessionId
    const live = this.lives.get(sessionId)
    const runId = this.leaseToRun.get(grant.leaseId) ?? evidence?.runId
    if (!live || !runId) {
      return {
        ok: false,
        error: {
          code: 'PAGE_HANDOFF_NO_POPUP',
          category: 'EXECUTOR',
          retryable: false,
          safeMessage: '页面交接缺少会话上下文',
        },
      }
    }
    const urls = await Promise.all(
      popped.map(async (item) => ({
        page: item,
        url:
          item.url() ||
          (await item
            .waitForLoadState('domcontentloaded')
            .then(() => item.url())
            .catch(() => '')),
      })),
    )
    const decided = pickPopupHandoff(urls, live.allowedOrigins, live.accessScope)
    if (!decided.ok) {
      return {
        ok: false,
        error: {
          code: decided.code,
          // 点击已经发出，交接结果未知：必须进核查，禁止当普通 EXECUTOR 失败重放点击。
          category: 'UNKNOWN',
          retryable: false,
          safeMessage: handoffMessage(decided.code),
        },
      }
    }
    const fromId = live.currentPageIdByLease.get(grant.leaseId) ?? live.currentPageIdByRun.get(runId)
    const entry = this.adoptPage(live, runId, decided.page, 'popup', grant.leaseId)
    if (entry.retarget) await entry.retarget.catch(() => undefined)
    await appendRunEvents(this.dbHandle, runId, [
      {
        type: 'run.page_handoff',
        payload: { fromPageId: fromId ?? null, toPageId: entry.pageId, reason: 'popup' },
        stepRunId: evidence?.stepRunId,
        attemptId: evidence?.attemptId,
      },
    ]).catch(() => undefined)
    await recordInlineLogEvidence(this.dbHandle, {
      runId,
      stepRunId: evidence?.stepRunId,
      attemptId: evidence?.attemptId,
      payload: { kind: 'page_handoff', fromPageId: fromId ?? null, toPageId: entry.pageId, reason: 'popup' },
    }).catch(() => undefined)
    return { ok: true, output: { pageAfter: 'popup', pageId: entry.pageId } }
  }

export function adoptPage(this: SessionManagerContext, 
    live: LiveHandle,
    runId: string,
    page: import('playwright').Page,
    kind: ManagedPageEntry['kind'],
    leaseId?: string,
  ): ManagedPageEntry {
    const entry = createManagedPage({ page, runId, kind })
    live.pages.set(entry.pageId, entry)
    live.currentPageIdByRun.set(runId, entry.pageId)
    if (leaseId) {
      live.currentPageIdByLease.set(leaseId, entry.pageId)
      if (typeof this.retargetVideoForLease === 'function') {
        entry.retarget = this.retargetVideoForLease(live, leaseId)
      }
    }
    return entry
  }

export function ensureRunPage(this: SessionManagerContext, live: LiveHandle, runId: string, leaseId?: string): ManagedPageEntry {
    const existingId = (leaseId ? live.currentPageIdByLease.get(leaseId) : undefined) ?? live.currentPageIdByRun.get(runId)
    const existing = existingId ? live.pages.get(existingId) : undefined
    if (existing && !existing.page.isClosed()) return existing
    const page =
      (leaseId ? live.runPages.get(leaseId) : undefined) ?? live.lastPage ?? live.handle.basePage
    return this.adoptPage(live, runId, page, live.runPages.has(leaseId ?? '') ? 'run' : live.lastPage ? 'run' : 'base', leaseId)
  }

function pageUsableForProjection(page: Page | undefined, basePage: Page): boolean {
  if (!page || page === basePage || page.isClosed()) return false
  try {
    const parsed = new URL(page.url())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function dropPageEntries(live: LiveHandle, page: Page) {
  for (const [id, entry] of [...live.pages]) {
    if (entry.page !== page) continue
    entry.dispose?.()
    live.pages.delete(id)
  }
}

async function retireRetainedPage(live: LiveHandle, keep?: Page): Promise<void> {
  const previous = live.lastPage
  if (!previous || previous === keep || previous === live.handle.basePage) return
  dropPageEntries(live, previous)
  if (!previous.isClosed()) await closePage(previous)
  if (live.lastPage === previous) live.lastPage = keep
}

export async function closeRunPage(this: SessionManagerContext, leaseId: string): Promise<void> {
    const sessionId = this.leaseToSession.get(leaseId)
    if (!sessionId) return
    const live = this.lives.get(sessionId)
    if (!live) return
    const page = live.runPages.get(leaseId)
    live.runPages.delete(leaseId)
    live.runPageIds.delete(leaseId)
    live.currentPageIdByLease.delete(leaseId)
    const runId = this.leaseToRun.get(leaseId)
    if (runId) live.currentPageIdByRun.delete(runId)
    if (!page) return
    if (pageUsableForProjection(page, live.handle.basePage)) {
      await retireRetainedPage(live, page)
      dropPageEntries(live, page)
      live.lastPage = page
      this.adoptPage(live, sessionId, page, 'run')
      return
    }
    dropPageEntries(live, page)
    if (page !== live.handle.basePage && !page.isClosed()) await closePage(page)
    if (live.lastPage === page) live.lastPage = undefined
  }

