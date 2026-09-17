import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { z } from 'zod'
import { JwtService } from '@nestjs/jwt'
import type { Response } from 'express'
import {
  cancelSessionOperation,
  disposeStuckSession,
  findActiveLeaseForSession,
  findAuthWaitLeaseForOperation,
  getAccountSessionDetail,
  getOrCreatePlatformConfig,
  getSessionById,
  getRun,
  findAuthWaitLeaseForRun,
  getSessionDto,
  getSessionOperation,
  getWorkerById,
  listAccountSessionOverview,
  listSessionSystemOverview,
  listSessionEvents,
  listSessionEventsAfter,
  listSessions,
  requestMaintenanceOperation,
  setSessionRetention,
  toSessionOperationDto,
  type DbHandle,
} from '@cairn/db'
import {
  DEFAULT_MANAGED_BROWSER_CAPABILITIES,
  canObserveManagedFrames,
  evaluateWorkerRoute,
  hasPermission,
  isSessionIdleOnlyKind,
  managedBrowserMetaSchema,
  parseWorkerEndpoints,
  platformConfigDocumentSchema,
  sessionEventListResponseSchema,
  sessionObserveQuerySchema,
  sessionOperationAcceptedSchema,
  sessionOperationDtoSchema,
  workerInternalPath,
  type BrowserSessionListQuery,
  type DisposeSessionBody,
  type RequestSessionOperationBody,
  type SessionListResponse,
  type SessionObserveQuery,
  type SessionOverviewQuery,
  type SessionRetentionBody,
  type SessionSystemOverviewQuery,
} from '@cairn/shared'
import { AuthService } from '../auth/auth.service'
import { classifyAccountRecheck, rethrowDomain } from '../common/domain-error'
import type { RequestAccount } from '../common/request-account'
import { config } from '../config/env'
import { DB_HANDLE } from '../db/db.module'
import { WorkerForwardError, WorkerInternalClient } from '../runs/worker-internal.client'

@Injectable()
export class BrowserSessionsService {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    private readonly workers: WorkerInternalClient,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  async list(query: BrowserSessionListQuery = {}): Promise<SessionListResponse> {
    return { items: await listSessions(this.handle, query) }
  }

  async overview(query: SessionOverviewQuery) {
    return listAccountSessionOverview(this.handle, query)
  }

  async systemOverview(query: SessionSystemOverviewQuery) {
    return listSessionSystemOverview(this.handle, query)
  }

  async get(sessionId: string) {
    try {
      const dto = await getSessionDto(this.handle, sessionId)
      if (!dto) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: '会话不存在' })
      return dto
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async events(sessionId: string, cursor?: string) {
    await this.get(sessionId)
    return sessionEventListResponseSchema.parse(await listSessionEvents(this.handle, { sessionId, cursor }))
  }

  async accountEvents(targetId: string, accountId: string, cursor?: string) {
    await this.accountDetail(targetId, accountId)
    return sessionEventListResponseSchema.parse(
      await listSessionEvents(this.handle, { key: { targetId, targetAccountId: accountId }, cursor }),
    )
  }

  async dispose(sessionId: string, body: DisposeSessionBody, actor: RequestAccount) {
    try {
      return await disposeStuckSession(this.handle, {
        sessionId,
        actor: { id: actor.id },
        note: body.note,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async accountDetail(targetId: string, accountId: string) {
    try {
      return await getAccountSessionDetail(this.handle, { targetId, targetAccountId: accountId })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async requestAccountOperation(
    targetId: string,
    accountId: string,
    body: RequestSessionOperationBody,
    actor: RequestAccount,
  ) {
    if (isSessionIdleOnlyKind(body.kind) && !hasPermission(actor.permissions, 'session:manage')) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: '关闭、重启或清除会话需要 session:manage' })
    }
    try {
      const result = await requestMaintenanceOperation(this.handle, {
        key: { targetId, targetAccountId: accountId },
        body,
        origin: 'USER',
        actor: { id: actor.id },
      })
      return sessionOperationAcceptedSchema.parse({
        operationId: result.operation?.id ?? null,
        reusedRunId: result.reusedRunId,
        created: result.created,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async setRetention(targetId: string, accountId: string, body: SessionRetentionBody, actor: RequestAccount) {
    try {
      return await setSessionRetention(this.handle, {
        key: { targetId, targetAccountId: accountId },
        body,
        actor: { id: actor.id },
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async getOperation(operationId: string) {
    const row = await getSessionOperation(this.handle, operationId)
    if (!row) throw new NotFoundException({ code: 'OPERATION_NOT_FOUND', message: '会话操作不存在' })
    return sessionOperationDtoSchema.parse(toSessionOperationDto(row))
  }

  async cancelOperation(operationId: string, actor: RequestAccount) {
    const row = await getSessionOperation(this.handle, operationId)
    if (!row) throw new NotFoundException({ code: 'OPERATION_NOT_FOUND', message: '会话操作不存在' })
    if (isSessionIdleOnlyKind(row.kind) && !hasPermission(actor.permissions, 'session:manage')) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: '取消该操作需要 session:manage' })
    }
    try {
      const moved = await cancelSessionOperation(this.handle, { operationId, actor: { id: actor.id } })
      return sessionOperationDtoSchema.parse(toSessionOperationDto(moved))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async completeAuth(operationId: string, actor: RequestAccount, body: { token: string }) {
    const row = await getSessionOperation(this.handle, operationId)
    if (!row) throw new NotFoundException({ code: 'OPERATION_NOT_FOUND', message: '会话操作不存在' })
    const reused = typeof row.kindParams?.reusedRunId === 'string' ? row.kindParams.reusedRunId : null
    if (reused) {
      if (!hasPermission(actor.permissions, 'run:execute')) throw new ForbiddenException({ code: 'FORBIDDEN', message: '继续运行需要 run:execute 权限' })
      return this.forwardJson(reused, actor, workerInternalPath('/resume-auth'), JSON.stringify(body))
    }
    return this.forwardJson(operationId, actor, workerInternalPath('/auth/complete'), JSON.stringify(body))
  }

  acquireAuth(operationId: string, body: unknown, actor: RequestAccount) {
    return this.forwardJson(
      operationId,
      actor,
      workerInternalPath('/auth-control/acquire'),
      JSON.stringify(body),
    )
  }

  heartbeatAuth(operationId: string, body: unknown, actor: RequestAccount) {
    return this.forwardJson(
      operationId,
      actor,
      workerInternalPath('/auth-control/heartbeat'),
      JSON.stringify(body),
    )
  }

  inputAuth(operationId: string, body: unknown, actor: RequestAccount) {
    return this.forwardJson(
      operationId,
      actor,
      workerInternalPath('/auth-control/input'),
      JSON.stringify(body),
    )
  }

  releaseAuth(operationId: string, body: unknown, actor: RequestAccount) {
    return this.forwardJson(
      operationId,
      actor,
      workerInternalPath('/auth-control/release'),
      JSON.stringify(body),
    )
  }

  async browserMeta(ownerId: string, actor: RequestAccount, pageId?: string) {
    const target = await this.resolveOwner(ownerId)
    if (!target.session || !target.worker || !target.endpoint) {
      return managedBrowserMetaSchema.parse({
        runId: ownerId,
        runStatus: target.status,
        sessionId: target.session?.id ?? null,
        sessionGeneration: target.session?.generation ?? null,
        ownerWorkerId: target.session?.ownerWorkerId ?? null,
        framesAvailable: false,
        viewingOtherPage: false,
        currentPage: null,
        pages: [],
        authHold: null,
        authControl: null,
        capabilities: DEFAULT_MANAGED_BROWSER_CAPABILITIES,
        degradedReason: 'worker_unreachable',
      })
    }
    try {
      const raw = await this.workers.requestJson({
        workerId: target.session.ownerWorkerId,
        workerInstanceId: target.worker.instanceId,
        actorId: actor.id,
        runId: target.ownerId,
        sessionGeneration: target.session.generation,
        path: workerInternalPath('/meta') + (pageId ? `?pageId=${encodeURIComponent(pageId)}` : ''),
        method: 'GET',
        endpoint: target.endpoint,
        timeout: 'headers',
      })
      return managedBrowserMetaSchema.parse(raw)
    } catch (error) {
      this.rethrowForward(error)
    }
  }

  async streamFrames(input: {
    ownerId: string
    pageId?: string
    actor: RequestAccount
    authorization?: string
    response: Response
    signal: AbortSignal
  }): Promise<void> {
    const target = await this.resolveOwner(input.ownerId)
    if (!target.session || !target.worker || !target.endpoint) {
      throw new ServiceUnavailableException({ code: 'WORKER_UNREACHABLE', message: '执行面暂时不可达' })
    }
    const upstreamAbort = new AbortController()
    const abort = () => upstreamAbort.abort()
    input.signal.addEventListener('abort', abort, { once: true })
    let upstream: globalThis.Response
    try {
      upstream = await this.workers.requestStream(
        {
          workerId: target.session.ownerWorkerId,
          workerInstanceId: target.worker.instanceId,
          actorId: input.actor.id,
          runId: target.ownerId,
          sessionGeneration: target.session.generation,
          path:
            workerInternalPath('/frames') +
            (input.pageId ? `?pageId=${encodeURIComponent(input.pageId)}` : ''),
          method: 'GET',
          endpoint: target.endpoint,
          timeout: 'stream',
        },
        upstreamAbort.signal,
      )
    } catch (error) {
      this.rethrowForward(error)
    }
    const res = input.response
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const expiresAt = this.tokenExpiresAt(input.authorization)
    const authTick = setInterval(() => {
      void this.recheck(input.actor.id, expiresAt, target.session?.id ?? null, target.status)
        .then((code) => {
          if (code) {
            upstreamAbort.abort()
            if (!res.writableEnded) res.end()
          }
        })
        .catch(() => undefined)
    }, 15_000)
    authTick.unref()
    const reader = upstream.body?.getReader()
    try {
      if (!reader) return
      while (!input.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) res.write(Buffer.from(value))
      }
    } finally {
      clearInterval(authTick)
      upstreamAbort.abort()
      input.signal.removeEventListener('abort', abort)
      await reader?.cancel().catch(() => undefined)
      if (!res.writableEnded) res.end()
    }
  }

  async streamObserve(input: {
    query: SessionObserveQuery
    account: RequestAccount
    authorization?: string
    response: Response
    signal: AbortSignal
  }): Promise<void> {
    const parsed = sessionObserveQuerySchema.parse(input.query)
    const key =
      parsed.targetId && parsed.accountId
        ? { targetId: parsed.targetId, targetAccountId: parsed.accountId }
        : undefined
    const res = input.response
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    let watermarks: Record<string, number> = {}
    if (parsed.cursor) {
      try {
        watermarks = z
          .record(z.string(), z.number().int().nonnegative())
          .parse(JSON.parse(Buffer.from(parsed.cursor, 'base64url').toString()))
      } catch {
        res.write('event: reset\ndata: {}\n\n')
      }
    }
    const expiresAt = this.tokenExpiresAt(input.authorization)
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      clearTimeout(timer)
      if (!res.writableEnded) res.end()
    }
    input.signal.addEventListener('abort', stop, { once: true })
    res.once('close', stop)
    let lastPing = 0
    const tick = async () => {
      if (input.signal.aborted || res.writableEnded) return
      try {
        const account = await this.auth.resolveAccount(input.account.id)
        if (
          Date.now() >= expiresAt ||
          account.status !== 'active' ||
          !hasPermission(account.permissions, 'session:read')
        ) {
          stop()
          return
        }
        const events = await listSessionEventsAfter(this.handle, { key, watermarks, limit: 100 })
        for (const event of events) {
          if (input.signal.aborted || res.writableEnded) return
          watermarks[event.targetAccountId] = event.seq
          const cursor = Buffer.from(JSON.stringify(watermarks)).toString('base64url')
          res.write(`id: ${cursor}\nevent: session\ndata: ${JSON.stringify(event)}\n\n`)
        }
        if (Date.now() - lastPing > 15_000) {
          res.write('event: ping\ndata: {}\n\n')
          lastPing = Date.now()
        }
      } catch {
        stop()
        return
      }
      if (!res.writableEnded && !input.signal.aborted) {
        timer = setTimeout(() => void tick(), 1000)
        timer.unref()
      }
    }
    await tick()
  }

  async retentionDefaults() {
    const current = await getOrCreatePlatformConfig(this.handle)
    return platformConfigDocumentSchema.parse(current.document).sessionRetention
  }

  private async forwardJson(ownerId: string, actor: RequestAccount, path: string, body: string) {
    const target = await this.resolveOwner(ownerId)
    if (!target.session || !target.worker || !target.endpoint) {
      throw new ServiceUnavailableException({ code: 'WORKER_UNREACHABLE', message: '执行面暂时不可达' })
    }
    try {
      return await this.workers.requestJson({
        workerId: target.session.ownerWorkerId,
        workerInstanceId: target.worker.instanceId,
        actorId: actor.id,
        runId: target.ownerId,
        sessionGeneration: target.session.generation,
        path,
        method: 'POST',
        endpoint: target.endpoint,
        timeout: 'auth',
        body,
      })
    } catch (error) {
      this.rethrowForward(error)
    }
  }

  private async resolveOwner(
    ownerId: string,
  ): Promise<Awaited<ReturnType<BrowserSessionsService['withWorker']>>> {
    const operation = await getSessionOperation(this.handle, ownerId)
    if (operation) {
      if (typeof operation.kindParams?.reusedRunId === 'string')
        return this.resolveRunOwner(operation.kindParams.reusedRunId)
      const lease = await findAuthWaitLeaseForOperation(this.handle, ownerId)
      const session = lease
        ? await getSessionById(this.handle, lease.sessionId)
        : operation.expectedSessionId
          ? await getSessionById(this.handle, operation.expectedSessionId)
          : null
      return this.withWorker(session, operation.status, ownerId)
    }
    const session = await getSessionById(this.handle, ownerId)
    if (!session) return this.resolveRunOwner(ownerId)
    const lease = await findActiveLeaseForSession(this.handle, session.id)
    if (lease?.runId) return this.resolveRunOwner(lease.runId)
    if (lease?.operationId) return this.resolveOwner(lease.operationId)
    return this.withWorker(session, session.status === 'OPEN' ? 'RUNNING' : 'FAILED', ownerId)
  }

  private async resolveRunOwner(ownerId: string) {
    const run = await getRun(this.handle, ownerId)
    const lease = await findAuthWaitLeaseForRun(this.handle, ownerId)
    const sessionId = lease?.sessionId ?? run.placement.sessionId
    return this.withWorker(
      sessionId ? await getSessionById(this.handle, sessionId) : null,
      run.status,
      ownerId,
    )
  }

  private async withWorker(
    session: Awaited<ReturnType<typeof getSessionById>>,
    status: string,
    ownerId: string,
  ) {
    const worker = session ? await getWorkerById(this.handle, session.ownerWorkerId) : null
    const endpoints = parseWorkerEndpoints(config.CAIRN_WORKER_ENDPOINTS, {
      networkMode: config.CAIRN_WORKER_NETWORK_MODE,
    })
    const evaluation = worker
      ? evaluateWorkerRoute({
          workerStatus: worker.status,
          workerInstanceId: worker.instanceId,
          sessionOwnerInstanceId: session?.ownerWorkerInstanceId ?? null,
          lostAfterSeconds: worker.lostAfterSeconds,
          heartbeatExpiresAt: worker.heartbeatExpiresAt,
          internalBaseUrl: worker.internalBaseUrl,
          asOf: new Date(),
          networkMode: config.CAIRN_WORKER_NETWORK_MODE,
          envEndpoint: endpoints[worker.id],
        })
      : null
    const live = Boolean(
      session?.status === 'OPEN' && evaluation?.availability === 'eligible' && evaluation.endpoint,
    )
    return {
      ownerId,
      status,
      session,
      worker: live ? worker : null,
      endpoint: live ? (evaluation?.endpoint ?? null) : null,
    }
  }

  private rethrowForward(error: unknown): never {
    if (error instanceof WorkerForwardError) {
      const body = { code: error.code, message: error.message }
      if (error.status === 404) throw new NotFoundException(body)
      if (error.status === 403) throw new ForbiddenException(body)
      if (error.status === 409) throw new ConflictException(body)
      if (error.status === 503) throw new ServiceUnavailableException(body)
      throw new ConflictException(body)
    }
    rethrowDomain(error)
  }

  private tokenExpiresAt(authorization?: string): number {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
    if (!token) return Date.now()
    const payload = this.jwt.decode(token)
    if (payload && typeof payload === 'object' && 'exp' in payload && typeof payload.exp === 'number') {
      return payload.exp * 1000
    }
    return Date.now() + 12 * 3600 * 1000
  }

  private async recheck(
    accountId: string,
    expiresAt: number,
    sessionId: string | null,
    status: string,
  ): Promise<'UNAUTHORIZED' | 'FORBIDDEN' | 'INTERNAL' | null> {
    if (Date.now() >= expiresAt) return 'UNAUTHORIZED'
    try {
      const account = await this.auth.resolveAccount(accountId)
      if (account.status === 'disabled') return 'FORBIDDEN'
      if (
        !hasPermission(account.permissions, 'session:read') ||
        !hasPermission(account.permissions, 'session:view')
      )
        return 'FORBIDDEN'
      if (!sessionId) return 'FORBIDDEN'
      const session = await getSessionById(this.handle, sessionId)
      if (!session || session.status !== 'OPEN') return 'FORBIDDEN'
      const latestOwner = await this.resolveOwner(sessionId)
      if (
        !canObserveManagedFrames({
          runStatus: latestOwner.status,
          actorId: accountId,
          controlActorId: session.authControlActorId,
          controlExpiresAt: session.authControlExpiresAt,
        })
      ) {
        return 'FORBIDDEN'
      }
      return null
    } catch (error) {
      return classifyAccountRecheck(error)
    }
  }
}
