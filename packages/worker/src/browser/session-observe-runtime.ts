import {
  appendRunEvents,
  conflict,
  expireStaleAuthControl,
  findActiveLeaseRow,
  findAuthWaitLeaseForOperation,
  getSessionOperation,
  findSessionByAuthWaitRun,
  authWaitLeaseLive,
  authHoldFromLease,
  findAuthWaitLeaseForRun,
  getRun,
  loadRunDetail,
  getSessionById,
  getWorkerById,
  updateRunDebugOverlay,
  type SessionRecord
} from '@cairn/db'
import {
  DEFAULT_MANAGED_BROWSER_CAPABILITIES,
  BROWSER_FRAME_MAX_FPS,
  canObserveManagedFrames,
  type AuthObservation,
  type AuthSignal,
  deriveRecoveryRule,
  isContextRecoverable,
  pageLooksLikeLogin,
  redactAuthUrl,
  type ManagedBrowserCapabilities,
  type ManagedBrowserFrame,
  type ManagedBrowserMeta,
  type ManagedPageSummary,
  type MapViewport,
  type ObserveOperation,
  type PageRef,
  type TargetObservation,
  type SessionGrant
} from '@cairn/shared'
import { highlightOnPage, pickOnPage } from './observe'
import { resolveObserveGrant } from './observe-grant'
import { refreshScreencastIfStale, startScreencast } from './screencast'
import { originAllowed, pageRefFor, type ManagedPageEntry } from './page-identity'
import { type LiveHandle, type SessionManagerContext } from './session-live.js'

export async function sampleMapConditions(this: SessionManagerContext, 
    grant: SessionGrant,
    _signal?: AbortSignal,
  ): Promise<{ locale?: string; viewport?: MapViewport; pageFrameObserved: boolean }> {
    try {
      return await this.withHeldOccupancy(grant.leaseId, grant, async () => {
        const page = this.pageForGrant(grant)
        if (!page) return { pageFrameObserved: false }
        let locale: string | undefined
        try {
          locale = await page.evaluate(() => navigator.language)
        } catch {
          locale = undefined
        }
        const size = typeof page.viewportSize === 'function' ? page.viewportSize() : null
        const viewport = size
          ? {
              category:
                size.width >= 1024 ? ('desktop' as const) : size.width >= 768 ? ('tablet' as const) : ('mobile' as const),
              widthPx: size.width,
              heightPx: size.height,
            }
          : undefined
        return { locale, viewport, pageFrameObserved: true }
      })
    } catch {
      return { pageFrameObserved: false }
    }
  }

export async function describeRunBrowser(this: SessionManagerContext, input: { runId: string; actorId: string; pageId?: string }): Promise<ManagedBrowserMeta> {
    return this.buildMeta(input.runId, input.actorId, input.pageId)
  }

export function invalidateObserveGrant(this: SessionManagerContext, runId: string): void {
    const current = this.observeGrants.get(runId)
    if (current) this.observeGrants.set(runId, { grant: { ...current.grant, epoch: current.grant.epoch + 1 }, expiresAt: 0 })
    this.observeGrants.delete(runId)
  }

export async function describeHoldPage(this: SessionManagerContext, runId: string): Promise<{
    pageRef?: PageRef
    url?: string
    authSignal?: AuthSignal
    authObservation?: AuthObservation
    contextRecoverable?: boolean
  } | undefined> {
    const sessionId = this.liveSessionIdForRun(runId)
    if (!sessionId) return undefined
    const live = this.lives.get(sessionId)
    const session = await getSessionById(this.dbHandle, sessionId)
    if (!live || !session) return undefined
    const entry = this.ensureRunPage(live, runId)
    if (entry.page.isClosed()) return undefined
    const url = entry.page.url()
    const leaseId = [...this.leaseToRun.entries()].find(([, mapped]) => mapped === runId)?.[0]
    const snapshot = leaseId ? this.runAuth.get(leaseId)?.snapshot : undefined
    const loginUrl = snapshot?.targetAuth?.loginUrl
    const onLogin = pageLooksLikeLogin({ pageUrl: url, loginUrl })
    const rule = snapshot
      ? deriveRecoveryRule({
          reuse: snapshot.sessionPolicy?.reuse,
          entryUrl: snapshot.targetAuth?.entryUrl,
          loginUrl: snapshot.targetAuth?.loginUrl,
          allowedOrigins: snapshot.allowedOrigins,
        })
      : undefined
    return {
      pageRef: pageRefFor(session.id, session.generation, entry),
      url: redactAuthUrl(url) ?? url,
      contextRecoverable: rule ? isContextRecoverable({ rule, pageUrl: url }) : false,
      ...(onLogin
        ? {
            authSignal: {
              kind: 'navigated_to_login' as const,
              at: new Date().toISOString(),
              summary: (redactAuthUrl(url) ?? url).slice(0, 512),
            },
            authObservation: this.expiredAuthObservation('导航到登录页', snapshot),
          }
        : {}),
    }
  }

export async function observeRun(this: SessionManagerContext, input: { runId: string; actorId: string; op: ObserveOperation }): Promise<TargetObservation> {
    const { session, live, run } = await this.requireLiveAuthSession(input.runId)
    if (run.status === 'WAITING_FOR_AUTH') {
      throw conflict('AUTH_CONTROL_HELD', '登录等待时不能指认或校验，请先完成认证')
    }
    if (run.status !== 'HOLDING') {
      throw conflict('RUN_NOT_HOLDING', '只有调试挂起中的运行允许观察页面')
    }
    const detail = await loadRunDetail(this.dbHandle, input.runId)
    if (detail?.stepRuns.some((step) => step.attempts.some((attempt) => attempt.status === 'RUNNING'))) {
      throw conflict('WAITING_FOR_STABLE_HOLD', '在途业务动作尚未停稳，不能签发观察授权')
    }
    const entry = this.ensureRunPage(live, input.runId)
    const pageRef = pageRefFor(session.id, session.generation, entry)
    const now = Date.now()
    const resolved = resolveObserveGrant({
      op: input.op.op,
      existing: this.observeGrants.get(input.runId),
      now,
      pageRef,
      sessionGeneration: session.generation,
      runId: input.runId,
    })
    if (!resolved.ok) {
      throw conflict('OBSERVE_GRANT_EXPIRED', '观察授权已过期，请重新校验或再次点选指认')
    }
    this.observeGrants.set(input.runId, resolved.issued)
    const grantOnly = input.op.op === 'highlight' && !input.op.target && !input.op.clearOverlayStepId
    const url = entry.page.url()
    const title = await entry.page.title().catch(() => undefined)
    const observation = grantOnly
      ? {
          outcome: 'NOT_FOUND' as const,
          page: { url, title, pageRef },
          diagnostics: { outcome: 'NOT_FOUND' as const, candidatesTried: [] },
          source: 'managed' as const,
        }
      : input.op.op === 'pick'
        ? await pickOnPage(entry.page, input.op.x ?? 0, input.op.y ?? 0)
        : input.op.target
          ? await highlightOnPage(entry.page, input.op.target)
          : {
              outcome: 'NOT_FOUND' as const,
              page: { url, title, pageRef },
              diagnostics: { outcome: 'NOT_FOUND' as const, candidatesTried: [] },
              source: 'managed' as const,
            }
    const withPage = { ...observation, page: { ...observation.page, pageRef } }
    if (!grantOnly) {
      await appendRunEvents(this.dbHandle, input.runId, [
        {
          type: input.op.op === 'pick' ? 'observation.picked' : 'observation.highlighted',
          payload: { outcome: observation.outcome, source: observation.source },
        },
      ])
      const stepId = input.op.clearOverlayStepId ?? detail?.checkpoint?.stepId
      if (input.op.clearOverlayStepId && detail) {
        const next = { ...(detail.debugOverlay?.stepOverrides ?? {}) }
        delete next[input.op.clearOverlayStepId]
        await updateRunDebugOverlay(this.dbHandle, input.runId, {
          revision: (detail.debugOverlay?.revision ?? 0) + 1,
          stepOverrides: next,
        })
      } else if (input.op.applyOverlay && observation.target && stepId) {
        await updateRunDebugOverlay(this.dbHandle, input.runId, {
          revision: (detail?.debugOverlay?.revision ?? 0) + 1,
          stepOverrides: {
            ...(detail?.debugOverlay?.stepOverrides ?? {}),
            [stepId]: { target: observation.target },
          },
        })
      }
    }
    return withPage
  }

export function subscribeRunFrames(this: SessionManagerContext, input: {
    runId: string
    actorId: string
    pageId?: string
    onFrame: (frame: ManagedBrowserFrame) => void
    signal: AbortSignal
  }): Promise<void> {
    return this.pipeFrames(input)
  }

export async function pipeFrames(this: SessionManagerContext, input: {
    runId: string
    actorId: string
    pageId?: string
    onFrame: (frame: ManagedBrowserFrame) => void
    signal: AbortSignal
  }): Promise<void> {
    const { session, live, run } = await this.requireLiveAuthSession(input.runId)
    if (
      !canObserveManagedFrames({
        runStatus: run.status,
        actorId: input.actorId,
        controlActorId: session.authControlActorId,
        controlExpiresAt: session.authControlExpiresAt,
      })
    ) {
      throw conflict('AUTH_CONTROL_INVALID', '认证阶段仅当前控制者可看画面')
    }
    const entry = this.pageForView(live, input.runId, input.pageId)
    if (!entry) throw conflict('PAGE_STALE', '没有可观察的页面')
    const pageRef = pageRefFor(session.id, session.generation, entry)
    let cast = live.screencasts.get(entry.pageId)
    if (!cast) {
      cast = await startScreencast(entry.page, pageRef)
      live.screencasts.set(entry.pageId, cast)
    }
    live.screencastObservers.set(entry.pageId, (live.screencastObservers.get(entry.pageId) ?? 0) + 1)
    if (cast) await refreshScreencastIfStale(entry.page, cast, pageRef)
    const interval = Math.max(500, Math.floor(1000 / BROWSER_FRAME_MAX_FPS))
    try {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let ticking = false
        let closed = false
        const finish = () => {
          if (closed) return
          closed = true
          if (timer) clearTimeout(timer)
          timer = undefined
          input.signal.removeEventListener('abort', finish)
          resolve()
        }
        const tick = () => {
          if (closed || input.signal.aborted) {
            finish()
            return
          }
          if (ticking) {
            timer = setTimeout(tick, interval)
            return
          }
          ticking = true
          void Promise.all([
            this.lookupRunSession(input.runId),
            getWorkerById(this.dbHandle, this.options.workerId),
          ])
            .then(async ([looked, worker]) => {
              const latestRun = looked.run
              const latestSession = looked.session
              if (closed || input.signal.aborted) return
              if (
                !latestSession ||
                latestSession.generation !== session.generation ||
                !this.sessionOwnedHere(latestSession) ||
                !this.registrationLive(worker)
              ) {
                finish()
                return
              }
              if (
                !canObserveManagedFrames({
                  runStatus: latestRun.status,
                  actorId: input.actorId,
                  controlActorId: latestSession.authControlActorId,
                  controlExpiresAt: latestSession.authControlExpiresAt,
                })
              ) {
                finish()
                return
              }
              if (cast) {
                await refreshScreencastIfStale(entry.page, cast, pageRef)
              }
              if (closed || input.signal.aborted) return
              if (cast?.latest) input.onFrame(cast.latest)
              if (closed || input.signal.aborted) return
              timer = setTimeout(tick, interval)
            })
            .catch(() => finish())
            .finally(() => {
              ticking = false
            })
        }
        if (cast?.latest && !input.signal.aborted) input.onFrame(cast.latest)
        timer = setTimeout(tick, interval)
        input.signal.addEventListener('abort', finish, { once: true })
        if (input.signal.aborted) finish()
      })
    } finally {
      await this.dropScreencastObserver(live, entry.pageId)
    }
  }

export async function dropScreencastObserver(this: SessionManagerContext, live: LiveHandle, pageId: string): Promise<void> {
    const current = live.screencastObservers.get(pageId) ?? 0
    if (current <= 1) {
      live.screencastObservers.delete(pageId)
      const cast = live.screencasts.get(pageId)
      live.screencasts.delete(pageId)
      await cast?.stop().catch(() => undefined)
      return
    }
    live.screencastObservers.set(pageId, current - 1)
  }

export function pageForView(this: SessionManagerContext, live: LiveHandle, runId: string, pageId?: string): ManagedPageEntry | undefined {
    if (pageId) {
      const chosen = live.pages.get(pageId)
      if (chosen && chosen.runId === runId && !chosen.page.isClosed()) {
        const url = typeof chosen.page.url === 'function' ? chosen.page.url() : ''
        if (!url || live.allowedOrigins.length === 0 || originAllowed(url, live.allowedOrigins, live.accessScope)) {
          return chosen
        }
      }
    }
    return this.ensureRunPage(live, runId)
  }

export async function requireLiveAuthSession(this: SessionManagerContext, runId: string): Promise<{
    session: SessionRecord
    live: LiveHandle
    run: Awaited<ReturnType<typeof getRun>>
  }> {
    const { run, session, live } = await this.lookupRunSession(runId)
    if (!session) throw conflict('WORKER_UNREACHABLE', '运行没有可观察的受管会话')
    this.assertSessionOwnedHere(session)
    if (!live) throw conflict('WORKER_UNREACHABLE', '本进程没有会话句柄')
    await expireStaleAuthControl(this.dbHandle, session.id, runId).catch(() => undefined)
    await this.assertOwnLiveRegistration()
    const latest = (await getSessionById(this.dbHandle, session.id)) ?? session
    this.assertSessionOwnedHere(latest)
    return { session: latest, live, run }
  }

export function sessionOwnedHere(this: SessionManagerContext, session: SessionRecord): boolean {
    return (
      session.ownerWorkerId === this.options.workerId &&
      Boolean(session.ownerWorkerInstanceId) &&
      session.ownerWorkerInstanceId === this.workerInstanceId
    )
  }

export function assertSessionOwnedHere(this: SessionManagerContext, session: SessionRecord): void {
    if (session.ownerWorkerId !== this.options.workerId) {
      throw conflict('WORKER_GENERATION_MISMATCH', '会话不属于当前 Worker')
    }
    if (!session.ownerWorkerInstanceId || session.ownerWorkerInstanceId !== this.workerInstanceId) {
      throw conflict('WORKER_GENERATION_MISMATCH', '会话不属于当前 Worker 实例')
    }
  }

export function registrationLive(this: SessionManagerContext, worker: Awaited<ReturnType<typeof getWorkerById>>): boolean {
    return Boolean(
      worker &&
        worker.instanceId === this.workerInstanceId &&
        worker.status === 'READY' &&
        worker.heartbeatExpiresAt &&
        worker.heartbeatExpiresAt.getTime() > Date.now(),
    )
  }

export async function assertOwnLiveRegistration(this: SessionManagerContext): Promise<void> {
    const worker = await getWorkerById(this.dbHandle, this.options.workerId)
    if (!this.registrationLive(worker)) {
      throw conflict('WORKER_GENERATION_MISMATCH', '当前登记已失效')
    }
  }

export function liveSessionIdForRun(this: SessionManagerContext, runId: string): string | undefined {
    for (const [leaseId, mappedRun] of this.leaseToRun) {
      if (mappedRun !== runId) continue
      const sessionId = this.leaseToSession.get(leaseId)
      if (sessionId && this.lives.has(sessionId)) return sessionId
    }
    for (const [sessionId, live] of this.lives) {
      if (live.currentPageIdByRun.has(runId)) return sessionId
      for (const entry of live.pages.values()) {
        if (entry.runId === runId && !entry.page.isClosed()) return sessionId
      }
    }
    return undefined
  }

export async function authWindowStatus(this: SessionManagerContext, runId: string): Promise<string> {
    const run = await getRun(this.dbHandle, runId).catch(() => null)
    if (run) return run.status
    const operation = await getSessionOperation(this.dbHandle, runId)
    if (operation) {
      return typeof operation.kindParams?.reusedRunId === 'string'
        ? this.authWindowStatus(operation.kindParams.reusedRunId)
        : operation.status
    }
    // 两种寻址都落空：把 getRun 的真实错误抛回去，不伪造状态。
    return (await getRun(this.dbHandle, runId)).status
  }

export async function lookupRunSession(this: SessionManagerContext, runId: string): Promise<{
    run: Awaited<ReturnType<typeof getRun>>
    session: SessionRecord | null
    live: LiveHandle | undefined
  }> {
    // Run 是正常寻址方式，必须先问；维护操作 id 与会话 id 只是控制台接管用的兜底，
    // 抢在 Run 前面会让真实 Run 被合成行盖掉，也让每次认证输入都多付一次查询。
    const detail = await getRun(this.dbHandle, runId).catch(() => null)
    if (detail) {
      const held = await findSessionByAuthWaitRun(this.dbHandle, runId)
      const sessionId =
        (held && authWaitLeaseLive(held.lease, new Date()) ? held.session.id : undefined) ??
        detail.placement.sessionId ??
        this.liveSessionIdForRun(runId)
      const session = sessionId ? await getSessionById(this.dbHandle, sessionId) : null
      return { run: detail, session, live: session ? this.lives.get(session.id) : undefined }
    }
    const operation = await getSessionOperation(this.dbHandle, runId)
    if (operation) {
      if (typeof operation.kindParams?.reusedRunId === 'string') {
        return this.lookupRunSession(operation.kindParams.reusedRunId)
      }
      const liveId = this.liveSessionIdForRun(runId)
      const lease =
        (await findAuthWaitLeaseForOperation(this.dbHandle, runId)) ??
        (liveId ? await findActiveLeaseRow(this.dbHandle, liveId) : null)
      const sessionId = lease?.sessionId ?? liveId ?? operation.expectedSessionId
      const session = sessionId ? await getSessionById(this.dbHandle, sessionId) : null
      const live = session ? this.lives.get(session.id) : undefined
      return {
        run: {
          id: operation.id,
          status: operation.status === 'WAITING_FOR_AUTH' ? 'WAITING_FOR_AUTH' : operation.status,
          placement: { sessionId: session?.id ?? null },
        } as Awaited<ReturnType<typeof getRun>>,
        session,
        live,
      }
    }
    const instance = await getSessionById(this.dbHandle, runId)
    if (instance) {
      const lease = await findActiveLeaseRow(this.dbHandle, instance.id)
      const ownerId = lease?.runId ?? lease?.operationId
      if (ownerId) return this.lookupRunSession(ownerId)
      return {
        run: {
          id: instance.id,
          status: instance.status === 'OPEN' ? 'RUNNING' : 'FAILED',
          placement: { sessionId: instance.id },
        } as Awaited<ReturnType<typeof getRun>>,
        session: instance,
        live: this.lives.get(instance.id),
      }
    }
    // 三种寻址都落空：把 getRun 的真实错误抛回去（未知 id 即 RUN_NOT_FOUND，库故障即原错误），
    // 不要在这里伪造一个空 Run。上面已经问过一次且失败，这行必定抛出。
    const run = await getRun(this.dbHandle, runId)
    return { run, session: null, live: undefined }
  }

export async function buildMeta(this: SessionManagerContext, runId: string, actorId: string, viewPageId?: string): Promise<ManagedBrowserMeta> {
    const { run, session, live } = await this.lookupRunSession(runId)
    const liveOk = Boolean(live && session && this.sessionOwnedHere(session))
    const waiting = run.status === 'WAITING_FOR_AUTH'
    const controlLive =
      Boolean(
        session?.authControlActorId &&
          session.authControlExpiresAt &&
          session.authControlExpiresAt.getTime() > Date.now(),
      )
    const heldByViewer = session?.authControlActorId === actorId && controlLive
    const capabilities: ManagedBrowserCapabilities = { ...DEFAULT_MANAGED_BROWSER_CAPABILITIES }
    const framesAvailable = liveOk && (!waiting || heldByViewer) && capabilities.screencast !== 'closed'
    const current = live && liveOk ? this.ensureRunPage(live, runId) : undefined
    const pages: ManagedPageSummary[] =
      live && liveOk && session
        ? [...live.pages.values()]
            .filter((entry) => entry.runId === runId && !entry.page.isClosed())
            .slice(0, 16)
            .map((entry) => ({
              pageRef: pageRefFor(session.id, session.generation, entry),
              kind: entry.kind,
              viewing: viewPageId ? entry.pageId === viewPageId : entry.pageId === current?.pageId,
              currentExecution: entry.pageId === current?.pageId,
            }))
        : []
    return {
      runId,
      runStatus: run.status,
      sessionId: session?.id ?? null,
      sessionGeneration: session?.generation ?? null,
      ownerWorkerId: session?.ownerWorkerId ?? null,
      framesAvailable,
      viewingOtherPage: Boolean(viewPageId && current && viewPageId !== current.pageId),
      currentPage: current && session ? (pages.find((item) => item.currentExecution) ?? null) : null,
      pages,
      authHold: await (async () => {
        const lease =
          (await findAuthWaitLeaseForRun(this.dbHandle, runId)) ??
          (await findAuthWaitLeaseForOperation(this.dbHandle, runId))
        const hold = authHoldFromLease(lease)
        return hold
          ? { expiresAt: hold.expiresAt.toISOString(), runId: hold.runId }
          : null
      })(),
      authControl: session
        ? {
            epoch: session.authControlEpoch,
            actorId: session.authControlActorId,
            expiresAt: session.authControlExpiresAt?.toISOString() ?? null,
            heldByViewer,
          }
        : null,
      capabilities,
      degradedReason: liveOk
        ? null
        : session && !this.sessionOwnedHere(session)
          ? 'worker_generation_mismatch'
          : session
            ? 'worker_unreachable'
            : null,
    }
  }

