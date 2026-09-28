import { appendRunEvents, conflict, recordInlineLogEvidence, setSessionProbe } from '@cairn/db'
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
  type ScreenshotDiagnosis,
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
  screenshotPage,
  pageHasSensitiveContent,
} from './runtime'
import { assertPageTargetScope, TargetScopeError } from './target-scope'
import { executeOnPage } from './surface'
import { handoffMessage } from './managed-helpers'
import { createManagedPage, pageRefFor, pickPopupHandoff, type ManagedPageEntry } from './page-identity'
import { type LiveHandle, type SessionManagerContext } from './session-live.js'
import {
  diagnoseScreenshot,
  isOmittableInitialBlank,
  pageLooksLoading,
  waitForVisibleContent,
  waitWhileLoading,
} from './screenshot-quality.js'

const RETAKE_BUDGET_MS = 2_000

type ManagedShot = {
  role: ScreenshotRole
  bytes: Buffer
  capturedAt?: string
  pageRef?: PageRef
  seq?: number
  diagnosis?: ScreenshotDiagnosis
}

export function assertCommand(this: SessionManagerContext, leaseId: string): SessionGrant {
    return this.guard.assertHeld(leaseId)
  }

export async function withManagedPage<T>(this: SessionManagerContext, 
    grant: SessionGrant,
    evidence: BrowserCommandEvidence | undefined,
    fn: (page: import('playwright').Page) => Promise<T>,
    failed: (value: T) => boolean = () => false,
    signal?: AbortSignal,
  ): Promise<
    | {
        ok: true
        value: T
        screenshotBytes?: Buffer
        extraShots?: ManagedShot[]
        screenshotCapturedAt?: string
        screenshotDiagnosis?: ScreenshotDiagnosis
        screenshotSeq?: number
        omittedBefore?: 'initial_blank_page'
        faceRole?: ScreenshotRole
        tracePath?: string
        screenshotSensitive?: boolean
      }
    | {
        ok: false
        error: Extract<BrowserCommandResult, { ok: false }>['error']
        screenshotBytes?: Buffer
        extraShots?: ManagedShot[]
        screenshotCapturedAt?: string
        screenshotDiagnosis?: ScreenshotDiagnosis
        screenshotSeq?: number
        omittedBefore?: 'initial_blank_page'
        faceRole?: ScreenshotRole
        tracePath?: string
        screenshotSensitive?: boolean
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
      this.runManagedPage(grant, evidence, fn, failed, signal),
    )
  }

export async function runManagedPage<T>(this: SessionManagerContext, 
    grant: SessionGrant,
    evidence: BrowserCommandEvidence | undefined,
    fn: (page: import('playwright').Page) => Promise<T>,
    failed: (value: T) => boolean,
    signal?: AbortSignal,
  ): Promise<
    | {
        ok: true
        value: T
        screenshotBytes?: Buffer
        extraShots?: ManagedShot[]
        screenshotCapturedAt?: string
        screenshotDiagnosis?: ScreenshotDiagnosis
        screenshotSeq?: number
        omittedBefore?: 'initial_blank_page'
        faceRole?: ScreenshotRole
        pageRef?: PageRef
        tracePath?: string
        screenshotSensitive?: boolean
      }
    | {
        ok: false
        error: Extract<BrowserCommandResult, { ok: false }>['error']
        screenshotBytes?: Buffer
        extraShots?: ManagedShot[]
        screenshotCapturedAt?: string
        screenshotDiagnosis?: ScreenshotDiagnosis
        screenshotSeq?: number
        omittedBefore?: 'initial_blank_page'
        faceRole?: ScreenshotRole
        pageRef?: PageRef
        tracePath?: string
        screenshotSensitive?: boolean
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
    const extraShots: ManagedShot[] = []
    const pageRefAt = (pageId: string | undefined): PageRef | undefined => {
      const entry = pageId ? live?.pages.get(pageId) : undefined
      return live && entry ? pageRefFor(live.sessionId, live.generation, entry) : undefined
    }
    const startPageId = live?.currentPageIdByLease.get(grant.leaseId)
    let omittedBefore: 'initial_blank_page' | undefined
    if (
      evidence &&
      evidence.commandType &&
      isSideEffectBrowserCommand(evidence.commandType) &&
      shouldCaptureEvidence(evidence.screenshot ?? 'on_failure', false)
    ) {
      const beforeAt = new Date().toISOString()
      const beforeRef = pageRefAt(startPageId)
      if (await isOmittableInitialBlank(page, evidence.commandType)) {
        omittedBefore = 'initial_blank_page'
      } else {
        const before = await screenshotPage(page, shotOpts).catch(() => undefined)
        if (before) {
          extraShots.push({
            role: 'before_action',
            bytes: before,
            capturedAt: beforeAt,
            pageRef: beforeRef,
            seq: 0,
            diagnosis: await diagnoseScreenshot(page, before),
          })
        }
      }
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
        const handoffAt = new Date().toISOString()
        const handoff = await screenshotPage(current, shotOpts).catch(() => undefined)
        if (handoff) {
          extraShots.push({
            role: 'handoff',
            bytes: handoff,
            capturedAt: handoffAt,
            pageRef,
            seq: 0,
            diagnosis: await diagnoseScreenshot(current, handoff),
          })
        }
      }
      let screenshotBytes = wantShot ? await screenshotPage(current, shotOpts).catch(() => undefined) : undefined
      let screenshotCapturedAt = screenshotBytes ? new Date().toISOString() : undefined
      let screenshotSeq = 0
      const canRetake =
        wantShot &&
        !failedNow &&
        evidence?.commandType === 'navigate' &&
        faceRole === 'after_action' &&
        !signal?.aborted
      if (canRetake && !screenshotBytes) {
        await waitForVisibleContent(current, RETAKE_BUDGET_MS, signal)
        if (!signal?.aborted) {
          screenshotBytes = await screenshotPage(current, shotOpts).catch(() => undefined)
          screenshotCapturedAt = screenshotBytes ? new Date().toISOString() : undefined
        }
      }
      let screenshotDiagnosis = screenshotBytes ? await diagnoseScreenshot(current, screenshotBytes) : undefined
      // 疑似空白必补拍；不是空白但仍能看到整页级加载遮罩/动画时，同样值得再等一次——
      // 不改判定语义（extraShot 仍记真实诊断，不冒充 suspected_blank），只是把「导航后
      // 内容还没画完」的补拍窗口从纯色空白扩大到「有壳无实质内容」的加载态。
      const stillLoading =
        canRetake && screenshotBytes && screenshotDiagnosis !== 'suspected_blank' && !signal?.aborted
          ? await pageLooksLoading(current)
          : false
      if (canRetake && screenshotBytes && (screenshotDiagnosis === 'suspected_blank' || stillLoading) && !signal?.aborted) {
        const firstBytes = screenshotBytes
        const firstAt = screenshotCapturedAt ?? new Date().toISOString()
        const firstDiagnosis = screenshotDiagnosis
        // 疑似空白：等到「有可见内容」；加载遮罩触发的补拍：等到「遮罩/动画消失」——
        // 壳层文字从一开始就在，用前者的等待条件会立刻判满足，根本等不到遮罩后的内容。
        if (stillLoading && firstDiagnosis !== 'suspected_blank') {
          await waitWhileLoading(current, RETAKE_BUDGET_MS, signal)
        } else {
          await waitForVisibleContent(current, RETAKE_BUDGET_MS, signal)
        }
        if (!signal?.aborted) {
          const retake = await screenshotPage(current, shotOpts).catch(() => undefined)
          if (retake) {
            extraShots.push({
              role: 'after_action',
              bytes: firstBytes,
              capturedAt: firstAt,
              pageRef,
              seq: 0,
              diagnosis: firstDiagnosis,
            })
            screenshotBytes = retake
            screenshotCapturedAt = new Date().toISOString()
            screenshotSeq = 1
            screenshotDiagnosis = await diagnoseScreenshot(current, retake)
            // 补拍是被加载遮罩触发的，且预算耗尽后遮罩仍在：如实标「疑似仍在加载」，
            // 不能让它跟一张正常渲染完的图长得一样、却把用户蒙在鼓里。
            if (
              stillLoading &&
              firstDiagnosis !== 'suspected_blank' &&
              screenshotDiagnosis === 'not_flagged' &&
              !signal?.aborted &&
              (await pageLooksLoading(current))
            ) {
              screenshotDiagnosis = 'still_loading'
            }
          }
        }
      }
      const screenshotSensitive = screenshotBytes
        ? await pageHasSensitiveContent(current, evidence?.sensitiveSelectors ?? [])
        : undefined
      return {
        ok: true,
        value,
        screenshotBytes,
        extraShots,
        faceRole,
        pageRef,
        tracePath,
        screenshotCapturedAt,
        screenshotDiagnosis,
        screenshotSeq,
        omittedBefore,
        screenshotSensitive,
      }
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
      const screenshotSensitive = screenshotBytes
        ? await pageHasSensitiveContent(current, evidence?.sensitiveSelectors ?? [])
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
          screenshotSensitive,
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
      extraShots?: ManagedShot[]
      faceRole?: ScreenshotRole
      pageRef?: PageRef
      screenshotCapturedAt?: string
      screenshotDiagnosis?: ScreenshotDiagnosis
      screenshotSeq?: number
      omittedBefore?: 'initial_blank_page'
      tracePath?: string
      screenshotSensitive?: boolean
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
      signal,
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
        screenshotCapturedAt: scoped.screenshotCapturedAt,
        screenshotDiagnosis: scoped.screenshotDiagnosis,
        screenshotSeq: scoped.screenshotSeq,
        omittedBefore: scoped.omittedBefore,
        tracePath: scoped.tracePath,
        screenshotSensitive: scoped.screenshotSensitive,
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
        screenshotCapturedAt: scoped.screenshotCapturedAt,
        screenshotDiagnosis: scoped.screenshotDiagnosis,
        screenshotSeq: scoped.screenshotSeq,
        omittedBefore: scoped.omittedBefore,
        tracePath: scoped.tracePath,
        screenshotSensitive: scoped.screenshotSensitive,
      }
    }
    return {
      ...scoped.value,
      screenshotBytes: scoped.screenshotBytes,
      extraShots: scoped.extraShots,
      faceRole: scoped.faceRole,
      pageRef: scoped.pageRef,
      screenshotCapturedAt: scoped.screenshotCapturedAt,
      screenshotDiagnosis: scoped.screenshotDiagnosis,
      screenshotSeq: scoped.screenshotSeq,
      omittedBefore: scoped.omittedBefore,
      tracePath: scoped.tracePath,
      screenshotSensitive: scoped.screenshotSensitive,
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
      return executeOnPage(page, command, signal, evidence)
    }
    let clickResult: BrowserCommandResult = { ok: false, error: { code: 'PAGE_HANDOFF_NO_POPUP', category: 'EXECUTOR', retryable: false, safeMessage: '点击未完成' } }
    const popped = await waitForPopupsFrom(page, async () => {
      clickResult = await executeOnPage(page, { ...command, pageAfter: 'same' }, signal, evidence)
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

export async function closeManagedPage(
  this: SessionManagerContext,
  input: { ownerId: string; pageId: string },
): Promise<{ closed: boolean; pageId: string; activePageId: string }> {
  const { session, live, run } = await this.lookupRunSession(input.ownerId)
  if (!live || !session || !this.sessionOwnedHere(session)) {
    throw conflict('SESSION_NOT_LIVE', '受管会话未在当前节点运行')
  }

  const entry = live.pages.get(input.pageId)
  const current = this.ensureRunPage(live, input.ownerId)
  if (!entry) {
    return { closed: true, pageId: input.pageId, activePageId: current.pageId }
  }

  // 1. 底页保护
  if (entry.page === live.handle.basePage) {
    throw conflict('CANNOT_CLOSE_BASE_PAGE', '会话底页用于维持登录状态，不可单独关闭')
  }

  // 2. 运行态保护
  const isCurrentActive = entry.pageId === current.pageId
  if (isCurrentActive && run.status === 'RUNNING') {
    throw conflict('CANNOT_CLOSE_ACTIVE_PAGE', '任务正在当前页面上执行，不可关闭')
  }

  // 3. 执行关闭与映射清理
  dropPageEntries(live, entry.page)
  if (!entry.page.isClosed()) {
    await closePage(entry.page)
  }

  // 4. 清理引用与回退
  if (live.lastPage === entry.page) {
    live.lastPage = undefined
  }

  if (isCurrentActive) {
    live.currentPageIdByRun.delete(input.ownerId)
    const baseEntry = this.ensureRunPage(live, input.ownerId)
    return { closed: true, pageId: input.pageId, activePageId: baseEntry.pageId }
  }

  return { closed: true, pageId: input.pageId, activePageId: current.pageId }
}


