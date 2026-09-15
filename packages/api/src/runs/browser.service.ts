import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { Response } from 'express'
import {
  getRun,
  isBoundAuthHold,
  resolveWorkerRoute,
  type DbHandle,
  type SessionRecord,
  type WorkerRecord,
} from '@cairn/db'
import {
  DEFAULT_MANAGED_BROWSER_CAPABILITIES,
  acquireAuthControlResponseSchema,
  authControlHeartbeatResponseSchema,
  authControlInputReceiptSchema,
  canObserveManagedFrames,
  evaluateWorkerRoute,
  hasAllPermissions,
  debugActionSchema,
  managedBrowserMetaSchema,
  observeOperationSchema,
  parseWorkerEndpoints,
  targetObservationSchema,
  workerInternalPath,
  workerRunsInternalPath,
  type AcquireAuthControlBody,
  type AuthControlInputBody,
  type AuthControlTokenBody,
  type DebugAction,
  type ManagedBrowserMeta,
  type ObserveOperation,
  type ResumeAuthBody,
} from '@cairn/shared'
import { config } from '../config/env'
import { AuthService } from '../auth/auth.service'
import type { RequestAccount } from '../common/request-account'
import { classifyAccountRecheck, rethrowDomain } from '../common/domain-error'
import { DB_HANDLE } from '../db/db.module'
import { WorkerForwardError, WorkerInternalClient } from './worker-internal.client'

@Injectable()
export class BrowserService {
  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    private readonly workers: WorkerInternalClient,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  async meta(runId: string, actor: RequestAccount, pageId?: string): Promise<ManagedBrowserMeta> {
    const target = await this.resolveTarget(runId)
    if (!target.session || !target.worker) return this.degraded(target, 'worker_unreachable')
    try {
      const raw = await this.workers.requestJson({
        ...this.callBase(target, actor, workerInternalPath('/meta'), 'headers'),
        method: 'GET',
        query: { pageId },
      })
      return managedBrowserMetaSchema.parse(raw)
    } catch (error) {
      if (error instanceof WorkerForwardError && error.code === 'WORKER_UNREACHABLE') {
        return this.degraded(target, 'worker_unreachable')
      }
      if (error instanceof WorkerForwardError && error.code === 'WORKER_GENERATION_MISMATCH') {
        return this.degraded(target, 'worker_generation_mismatch')
      }
      this.rethrowForward(error)
    }
  }

  async streamFrames(input: {
    runId: string
    pageId?: string
    actor: RequestAccount
    authorization?: string
    response: Response
    signal: AbortSignal
  }): Promise<void> {
    const target = await this.resolveTarget(input.runId)
    if (!target.session || !target.worker) {
      throw new ServiceUnavailableException({ code: 'WORKER_UNREACHABLE', message: '执行面暂时不可达' })
    }
    let upstream: globalThis.Response
    try {
      upstream = await this.workers.requestStream(
        {
          ...this.callBase(target, input.actor, workerInternalPath('/frames'), 'stream'),
          method: 'GET',
          query: { pageId: input.pageId },
        },
        input.signal,
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
      void this.recheck(input.actor.id, expiresAt, input.runId)
        .then((code) => {
          if (!code) return
          if (!res.writableEnded) res.end()
        })
        .catch(() => undefined)
    }, 15_000)
    authTick.unref()
    try {
      if (!upstream.body) return
      const reader = upstream.body.getReader()
      while (!input.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) res.write(Buffer.from(value))
      }
    } finally {
      clearInterval(authTick)
      if (!res.writableEnded) res.end()
    }
  }

  acquire(runId: string, body: AcquireAuthControlBody, actor: RequestAccount) {
    return this.mutate(runId, actor, workerInternalPath('/auth-control/acquire'), JSON.stringify(body), acquireAuthControlResponseSchema)
  }

  heartbeat(runId: string, body: AuthControlTokenBody, actor: RequestAccount) {
    return this.mutate(runId, actor, workerInternalPath('/auth-control/heartbeat'), JSON.stringify(body), authControlHeartbeatResponseSchema)
  }

  input(runId: string, body: AuthControlInputBody, actor: RequestAccount) {
    return this.mutate(runId, actor, workerInternalPath('/auth-control/input'), JSON.stringify(body), authControlInputReceiptSchema)
  }

  release(runId: string, body: AuthControlTokenBody, actor: RequestAccount) {
    return this.mutate(runId, actor, workerInternalPath('/auth-control/release'), JSON.stringify(body))
  }

  async resumeAuth(runId: string, body: ResumeAuthBody, actor: RequestAccount) {
    await this.mutate(runId, actor, workerInternalPath('/resume-auth'), JSON.stringify(body))
    return getRun(this.db, runId).catch(rethrowDomain)
  }

  observe(runId: string, body: ObserveOperation, actor: RequestAccount) {
    return this.mutate(
      runId,
      actor,
      workerInternalPath('/observe'),
      JSON.stringify(observeOperationSchema.parse(body)),
      targetObservationSchema,
    )
  }

  async debug(runId: string, body: DebugAction, actor: RequestAccount) {
    await this.mutate(
      runId,
      actor,
      workerRunsInternalPath('/debug-resume'),
      JSON.stringify(debugActionSchema.parse(body)),
    )
    return getRun(this.db, runId).catch(rethrowDomain)
  }

  private async mutate(
    runId: string,
    actor: RequestAccount,
    path: string,
    body: string,
    schema?: { parse: (value: unknown) => unknown },
  ) {
    const target = await this.resolveTarget(runId)
    if (!target.session || !target.worker) {
      throw new ServiceUnavailableException({ code: 'WORKER_UNREACHABLE', message: '执行面暂时不可达' })
    }
    try {
      const raw = await this.workers.requestJson({
        ...this.callBase(target, actor, path, 'auth'),
        method: 'POST',
        body,
      })
      return schema ? schema.parse(raw) : raw
    } catch (error) {
      this.rethrowForward(error)
    }
  }

  private callBase(
    target: Awaited<ReturnType<BrowserService['resolveTarget']>>,
    actor: RequestAccount,
    path: string,
    timeout: 'headers' | 'auth' | 'stream',
  ) {
    return {
      workerId: target.session!.ownerWorkerId,
      workerInstanceId: target.worker!.instanceId,
      actorId: actor.id,
      runId: target.run.id,
      sessionGeneration: target.session!.generation,
      path,
      endpoint: target.endpoint!,
      timeout,
    }
  }

  private async resolveTarget(runId: string): Promise<{
    run: { id: string; status: string }
    session: SessionRecord | null
    worker: WorkerRecord | null
    endpoint: string | null
  }> {
    try {
      const route = await resolveWorkerRoute(this.db, runId)
      const endpoints = parseWorkerEndpoints(config.CAIRN_WORKER_ENDPOINTS, {
        networkMode: config.CAIRN_WORKER_NETWORK_MODE,
      })
      const evaluation = evaluateWorkerRoute({
        workerStatus: route.worker?.status ?? null,
        workerInstanceId: route.worker?.instanceId ?? null,
        sessionOwnerInstanceId: route.session?.ownerWorkerInstanceId ?? null,
        lostAfterSeconds: route.worker?.lostAfterSeconds ?? null,
        heartbeatExpiresAt: route.worker?.heartbeatExpiresAt ?? null,
        internalBaseUrl: route.worker?.internalBaseUrl ?? null,
        asOf: route.asOf,
        networkMode: config.CAIRN_WORKER_NETWORK_MODE,
        envEndpoint: route.worker ? endpoints[route.worker.id] : undefined,
      })
      const live =
        route.associationLive &&
        route.session?.status === 'OPEN' &&
        evaluation.availability === 'eligible' &&
        evaluation.endpoint
      return {
        run: { id: route.runId, status: route.runStatus },
        session: route.session,
        worker: live ? route.worker : null,
        endpoint: live ? evaluation.endpoint : null,
      }
    } catch (error) {
      rethrowDomain(error)
    }
  }

  private degraded(
    target: Awaited<ReturnType<BrowserService['resolveTarget']>>,
    reason: 'worker_unreachable' | 'worker_generation_mismatch',
  ): ManagedBrowserMeta {
    const session = target.session
    return managedBrowserMetaSchema.parse({
      runId: target.run.id,
      runStatus: target.run.status,
      sessionId: session?.id ?? null,
      sessionGeneration: session?.generation ?? null,
      ownerWorkerId: session?.ownerWorkerId ?? null,
      framesAvailable: false,
      viewingOtherPage: false,
      currentPage: null,
      pages: [],
      authHold:
        session && isBoundAuthHold(session) && session.authHoldExpiresAt
          ? {
              expiresAt: session.authHoldExpiresAt.toISOString(),
              bound: true,
              runId: session.authHoldRunId,
            }
          : null,
      authControl: session
        ? {
            epoch: session.authControlEpoch,
            actorId: session.authControlActorId,
            expiresAt: session.authControlExpiresAt?.toISOString() ?? null,
            heldByViewer: false,
          }
        : null,
      capabilities: DEFAULT_MANAGED_BROWSER_CAPABILITIES,
      degradedReason: reason,
    })
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
    runId: string,
  ): Promise<'UNAUTHORIZED' | 'FORBIDDEN' | 'INTERNAL' | null> {
    if (Date.now() >= expiresAt) return 'UNAUTHORIZED'
    try {
      const account = await this.auth.resolveAccount(accountId)
      if (account.status === 'disabled') return 'FORBIDDEN'
      if (!hasAllPermissions(account.permissions, ['run:read', 'session:view'])) return 'FORBIDDEN'
      const target = await this.resolveTarget(runId)
      if (!target.worker || !target.endpoint || target.session?.status !== 'OPEN') return 'FORBIDDEN'
      if (
        !canObserveManagedFrames({
          runStatus: target.run.status,
          actorId: accountId,
          controlActorId: target.session.authControlActorId,
          controlExpiresAt: target.session.authControlExpiresAt,
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
