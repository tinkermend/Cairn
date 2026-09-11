import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import {
  acquireSessionLease,
  claimAuthHold,
  closeWorkerSessions,
  countOpenSessionsForWorker,
  createSession,
  eq,
  expireAuthHold,
  expireStaleLeases,
  failRunAuthTimeout,
  findLiveSession,
  getSessionById,
  listExpiredAuthHolds,
  listReapableSessions,
  listRunsWaitingForAuthByAccount,
  loadSecretCiphertext,
  markRunWaitingForAuth,
  markSessionsClosing,
  releaseAuthHold,
  releaseSessionLease,
  renewSessionLease,
  revokeWorkerLeases,
  setSessionProbe,
  setSessionStatus,
  targetAccounts,
  targets,
  type DbHandle,
  type LeaseRecord,
  type SessionRecord,
} from '@cairn/db'
import {
  DEFAULT_SESSION_POLICY,
  LOCAL_SECRET_PROVIDER,
  resolveSessionPolicy,
  type RunSnapshot,
  type SessionErrorCode,
  type SessionGrant,
  type SessionPolicy,
} from '@cairn/shared'
import type { LocalSecretProvider } from '@cairn/secret'
import { DB_HANDLE } from '../db/db.module'
import { SessionGuard, GuardError } from './guard'
import { ensureProfileDir } from './profiles'
import { pageStrategyForReuse, shouldRecreateSession } from './reuse'
import {
  BrowserRuntimeError,
  closePage,
  countPages,
  launchSession,
  loginWithCredentials,
  openRunPage,
  probeAuth,
  probeHealth,
  stopSession,
  type BrowserHandle,
  type TargetAuthInfo,
} from './runtime'

export type BrowserSessionManagerOptions = {
  workerId: string
  profileRoot: string
  headless: boolean
  maxSessions: number
  executablePath?: string
  defaultLeaseTtlSeconds: number
  defaultAuthWaitSeconds: number
  heartbeatMs: number
}

export const BROWSER_SESSION_OPTIONS = Symbol('BROWSER_SESSION_OPTIONS')
export const SECRET_PROVIDER = Symbol('SECRET_PROVIDER')

export type SessionAcquireResult =
  | { ok: true; grant: SessionGrant }
  | { ok: false; code: SessionErrorCode; message: string; waitingForAuth?: boolean }

export class SessionLeaseError extends Error {
  readonly code: SessionErrorCode

  constructor(code: SessionErrorCode, message: string) {
    super(message)
    this.name = 'SessionLeaseError'
    this.code = code
  }
}

type LiveHandle = {
  handle: BrowserHandle
  sessionId: string
  runPageIds: Set<string>
  runPages: Map<string, Awaited<ReturnType<typeof openRunPage>>>
}

@Injectable()
export class BrowserSessionManager {
  private readonly logger = new Logger(BrowserSessionManager.name)
  readonly guard = new SessionGuard()
  private readonly lives = new Map<string, LiveHandle>()
  private readonly leaseToSession = new Map<string, string>()
  private heartbeat: NodeJS.Timeout | undefined
  private reconciled = false

  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    @Inject(BROWSER_SESSION_OPTIONS) private readonly options: BrowserSessionManagerOptions,
    @Optional() @Inject(SECRET_PROVIDER) private readonly secrets?: LocalSecretProvider,
  ) {}

  startHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      void this.renewAll().catch((error) => {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'lease.renew_cycle_failed',
        )
      })
    }, this.options.heartbeatMs)
  }

  stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
  }

  /** Worker 启动自愈：名下活会话必然已不在。 */
  async reconcileOwn(): Promise<{ leasesRevoked: number; sessionsClosed: number }> {
    if (this.reconciled) {
      return { leasesRevoked: 0, sessionsClosed: 0 }
    }
    const db = this.dbHandle.db
    const leasesRevoked = await revokeWorkerLeases(db, this.options.workerId)
    const sessionsClosed = await closeWorkerSessions(db, this.options.workerId)
    this.reconciled = true
    this.logger.log(
      { workerId: this.options.workerId, leasesRevoked, sessionsClosed },
      'session.reconcile_own',
    )
    return { leasesRevoked, sessionsClosed }
  }

  async acquire(run: RunSnapshot, _signal?: AbortSignal): Promise<SessionAcquireResult> {
    if (!run.targetAccountId) {
      return {
        ok: false,
        code: 'SESSION_ACCOUNT_REQUIRED',
        message: '浏览器步骤需要 targetAccountId',
      }
    }

    const policy = resolveSessionPolicy(run.sessionPolicy, this.platformDefaultPolicy())
    const key = { targetId: run.targetId, targetAccountId: run.targetAccountId }
    const db = this.dbHandle.db

    let live = await findLiveSession(db, key)

    if (shouldRecreateSession(policy.reuse) && live) {
      if (live.ownerWorkerId === this.options.workerId) {
        await this.close(live.id, 'recreate_session')
        live = null
      } else {
        return {
          ok: false,
          code: 'SESSION_BUSY',
          message: '会话由其他 Worker 持有，无法 RECREATE',
        }
      }
    }

    if (!live) {
      const openCount = await countOpenSessionsForWorker(db, this.options.workerId)
      if (openCount >= this.options.maxSessions) {
        return {
          ok: false,
          code: 'SESSION_CAPACITY_EXCEEDED',
          message: `本 Worker 会话数已达上限 ${this.options.maxSessions}`,
        }
      }

      try {
        const created = await createSession(db, {
          key,
          ownerWorkerId: this.options.workerId,
          reusePolicy: policy.reuse,
          idleTtlSeconds: policy.idleTtlSeconds,
          maxLifetimeSeconds: policy.maxLifetimeSeconds,
        })
        const launched = await this.launchAndOpen(created, key)
        if (!launched.ok) return launched
        live = launched.session
        this.logger.log(
          {
            sessionId: live.id,
            generation: live.generation,
            workerId: this.options.workerId,
            runId: run.runId,
          },
          'session.created',
        )
      } catch (error) {
        if (error instanceof BrowserRuntimeError) {
          return { ok: false, code: error.code, message: error.message }
        }
        if (error && typeof error === 'object' && 'code' in error) {
          const code = String((error as { code: unknown }).code)
          if (code === 'SESSION_BUSY') {
            live = await findLiveSession(db, key)
            if (!live) {
              return { ok: false, code: 'SESSION_BUSY', message: '同键会话创建冲突' }
            }
          } else {
            throw error
          }
        } else {
          throw error
        }
      }
    } else {
      if (live.ownerWorkerId !== this.options.workerId) {
        return {
          ok: false,
          code: 'SESSION_BUSY',
          message: `会话 owner 为 ${live.ownerWorkerId}`,
        }
      }
      if (live.status !== 'OPEN' || live.health === 'UNHEALTHY') {
        return {
          ok: false,
          code: 'SESSION_NOT_CLAIMABLE',
          message: `会话不可领取 status=${live.status} health=${live.health}`,
        }
      }
      if (!this.lives.has(live.id)) {
        return {
          ok: false,
          code: 'SESSION_NOT_CLAIMABLE',
          message: '本进程无会话句柄，请等待自愈或重建',
        }
      }
      this.logger.log(
        {
          sessionId: live.id,
          generation: live.generation,
          workerId: this.options.workerId,
          runId: run.runId,
        },
        'session.reused',
      )
    }

    const auth = await this.ensureAuth(live, run, policy)
    if (!auth.ok) return auth
    live = auth.session

    const leaseOutcome = await acquireSessionLease(db, {
      sessionId: live.id,
      runId: run.runId,
      holderWorkerId: this.options.workerId,
      leaseTtlSeconds: policy.leaseTtlSeconds,
    })
    if (!leaseOutcome.ok) {
      return {
        ok: false,
        code: leaseOutcome.code,
        message:
          leaseOutcome.code === 'SESSION_BUSY'
            ? `会话忙 holder=${leaseOutcome.busy.holderWorkerId}`
            : '会话不可领取',
      }
    }

    const lease = leaseOutcome.lease
    await this.applyReuse(live, policy, lease.id)

    const grant: SessionGrant = {
      sessionId: live.id,
      leaseId: lease.id,
      generation: lease.sessionGeneration,
      sessionFencingToken: lease.sessionFencingToken,
      expiresAt: lease.expiresAt.toISOString(),
    }
    this.guard.install(grant)
    this.leaseToSession.set(lease.id, live.id)
    this.logger.log(
      {
        sessionId: grant.sessionId,
        leaseId: grant.leaseId,
        sessionGeneration: grant.generation,
        fencingToken: grant.sessionFencingToken,
        workerId: this.options.workerId,
        runId: run.runId,
      },
      'lease.acquired',
    )
    return { ok: true, grant }
  }

  async renew(leaseId: string, leaseTtlSeconds?: number): Promise<'ok' | 'lost'> {
    const ttl = leaseTtlSeconds ?? this.options.defaultLeaseTtlSeconds
    const row = await renewSessionLease(this.dbHandle.db, {
      leaseId,
      holderWorkerId: this.options.workerId,
      leaseTtlSeconds: ttl,
    })
    if (!row) {
      this.guard.revoke(leaseId)
      this.logger.warn({ leaseId, workerId: this.options.workerId }, 'lease.renew_failed')
      return 'lost'
    }
    const grant: SessionGrant = {
      sessionId: row.sessionId,
      leaseId: row.id,
      generation: row.sessionGeneration,
      sessionFencingToken: row.sessionFencingToken,
      expiresAt: row.expiresAt.toISOString(),
    }
    this.guard.refresh(grant)
    return 'ok'
  }

  /**
   * 释放租约。行不存在 → SESSION_LEASE_UNKNOWN；已非 ACTIVE 视为幂等成功。
   */
  async release(leaseId: string, reason: string): Promise<void> {
    const sessionId = this.leaseToSession.get(leaseId)
    await this.closeRunPage(leaseId)
    const result = await releaseSessionLease(this.dbHandle.db, {
      leaseId,
      holderWorkerId: this.options.workerId,
      reason,
    })
    this.guard.revoke(leaseId)
    this.leaseToSession.delete(leaseId)
    if (result === 'unknown') {
      throw new SessionLeaseError('SESSION_LEASE_UNKNOWN', `租约不存在: ${leaseId}`)
    }
    this.logger.log(
      { leaseId, sessionId, reason, result, workerId: this.options.workerId },
      'lease.released',
    )
  }

  async close(sessionId: string, reason: string): Promise<void> {
    const db = this.dbHandle.db
    const session = await getSessionById(db, sessionId)
    if (!session) return
    if (session.ownerWorkerId !== this.options.workerId) return

    this.logger.log(
      { sessionId, generation: session.generation, reason, workerId: this.options.workerId },
      'session.closing',
    )
    await setSessionStatus(db, {
      sessionId,
      expectedVersion: session.version,
      status: 'CLOSING',
      closeReason: reason,
      ownerWorkerId: this.options.workerId,
    })

    const live = this.lives.get(sessionId)
    let stopResult: 'stopped' | 'unconfirmed' = 'stopped'
    if (live) {
      for (const page of live.runPages.values()) {
        await closePage(page)
      }
      stopResult = await stopSession(live.handle)
      this.lives.delete(sessionId)
    } else {
      // 无本进程句柄：无法确认浏览器是否仍在 → LOST（阻塞键）
      stopResult = 'unconfirmed'
    }

    const latest = (await getSessionById(db, sessionId))!
    if (stopResult === 'stopped') {
      await setSessionStatus(db, {
        sessionId,
        expectedVersion: latest.version,
        status: 'CLOSED',
        closeReason: reason,
        ownerWorkerId: this.options.workerId,
      })
      this.logger.log({ sessionId, reason, workerId: this.options.workerId }, 'session.closed')
    } else {
      await setSessionStatus(db, {
        sessionId,
        expectedVersion: latest.version,
        status: 'LOST',
        closeReason: reason,
        ownerWorkerId: this.options.workerId,
      })
      this.logger.warn({ sessionId, reason, workerId: this.options.workerId }, 'session.lost')
    }
  }

  async reap(): Promise<{
    leasesExpired: number
    sessionsClosed: number
    authTimeouts: number
  }> {
    const db = this.dbHandle.db
    const leasesExpired = await expireStaleLeases(db)
    if (leasesExpired > 0) {
      this.logger.log({ leasesExpired, workerId: this.options.workerId }, 'lease.expired')
    }

    const authTimeouts = await this.reapAuthTimeouts()

    // 控制面可能已处置掉本进程的卡死会话（例如 LOST 后人工放行）。句柄若还在，
    // 必须停掉浏览器——否则旧进程带着同一 profile 活着，正是处置要消除的双开风险。
    const disposedDropped = await this.dropDisposedHandles()

    const reapable = await listReapableSessions(db, this.options.workerId)
    if (reapable.length > 0) {
      await markSessionsClosing(db, {
        workerId: this.options.workerId,
        sessionIds: reapable.map((s) => s.id),
        reason: 'idle_or_max_lifetime',
      })
    }

    let sessionsClosed = 0
    for (const session of reapable) {
      await this.close(session.id, 'idle_or_max_lifetime')
      sessionsClosed += 1
    }

    // 健康探针：对本进程活句柄探测，不刷新 last_used_at
    for (const [sessionId, live] of this.lives) {
      const health = await probeHealth(live.handle)
      await setSessionProbe(db, {
        sessionId,
        ownerWorkerId: this.options.workerId,
        health,
      })
      if (health === 'UNHEALTHY') {
        await this.close(sessionId, 'unhealthy')
        sessionsClosed += 1
      }
    }

    this.logger.log(
      { leasesExpired, sessionsClosed, authTimeouts, disposedDropped, workerId: this.options.workerId },
      'reap.cycle',
    )
    return { leasesExpired, sessionsClosed, authTimeouts }
  }

  /**
   * 丢弃已不由本进程拥有的会话句柄：行已 CLOSED、已消失，或 owner 换了人。
   *
   * 处置只改库，停不了浏览器；句柄在本进程时由这里收尾。租约映射一并清掉——
   * 处置已经把它们 REVOKED，留着只会让心跳反复判定丢租。
   */
  private async dropDisposedHandles(): Promise<number> {
    const db = this.dbHandle.db
    let dropped = 0
    for (const [sessionId, live] of [...this.lives]) {
      const row = await getSessionById(db, sessionId)
      const stillOurs =
        row !== null && row.status !== 'CLOSED' && row.ownerWorkerId === this.options.workerId
      if (stillOurs) continue

      for (const page of live.runPages.values()) await closePage(page)
      await stopSession(live.handle)
      this.lives.delete(sessionId)
      for (const [leaseId, mapped] of [...this.leaseToSession]) {
        if (mapped !== sessionId) continue
        this.guard.revoke(leaseId)
        this.leaseToSession.delete(leaseId)
      }
      dropped += 1
      this.logger.warn(
        { sessionId, status: row?.status ?? 'missing', workerId: this.options.workerId },
        'session.disposed_externally',
      )
    }
    return dropped
  }

  /**
   * 认证等待超时：清占用、会话仍 OPEN、auth_state=EXPIRED；
   * 绑定该账号的 WAITING_FOR_AUTH Run → SESSION_AUTH_TIMEOUT 失败。
   */
  async reapAuthTimeouts(): Promise<number> {
    const db = this.dbHandle.db
    const expired = await listExpiredAuthHolds(db, this.options.workerId)
    let n = 0
    for (const session of expired) {
      await expireAuthHold(db, { sessionId: session.id, workerId: this.options.workerId })
      const runIds = await listRunsWaitingForAuthByAccount(db, session.targetAccountId)
      for (const runId of runIds) {
        const failed = await failRunAuthTimeout(db, runId)
        if (failed) {
          n += 1
          this.logger.log(
            {
              sessionId: session.id,
              runId,
              workerId: this.options.workerId,
            },
            'session.auth_timeout',
          )
        }
      }
      this.logger.log(
        { sessionId: session.id, authState: 'EXPIRED', workerId: this.options.workerId },
        'session.auth_changed',
      )
    }
    return n
  }

  /** 停机：释放名下租约并关闭浏览器。 */
  async shutdown(): Promise<void> {
    this.stopHeartbeat()
    for (const leaseId of [...this.leaseToSession.keys()]) {
      try {
        await this.release(leaseId, 'worker_shutdown')
      } catch {
        // 停机路径：未知租约也清本地
        this.guard.revoke(leaseId)
        this.leaseToSession.delete(leaseId)
      }
    }
    for (const sessionId of [...this.lives.keys()]) {
      await this.close(sessionId, 'worker_shutdown')
    }
    this.guard.clear()
  }

  assertCommand(leaseId: string): SessionGrant {
    return this.guard.assertHeld(leaseId)
  }

  pageCount(sessionId: string): number {
    const live = this.lives.get(sessionId)
    return live ? countPages(live.handle) : 0
  }

  /** 测试钩子：覆盖默认 SecretProvider 解密。 */
  resolveCredential?: (run: RunSnapshot) => Promise<{ username: string; password: string } | null>

  private platformDefaultPolicy(): SessionPolicy {
    return {
      ...DEFAULT_SESSION_POLICY,
      leaseTtlSeconds: this.options.defaultLeaseTtlSeconds,
      authWaitSeconds: this.options.defaultAuthWaitSeconds,
    }
  }

  private async renewAll(): Promise<void> {
    for (const leaseId of [...this.leaseToSession.keys()]) {
      const result = await this.renew(leaseId)
      if (result === 'lost') {
        await this.closeRunPage(leaseId)
        this.leaseToSession.delete(leaseId)
      }
    }
  }

  private async launchAndOpen(
    created: SessionRecord,
    key: { targetId: string; targetAccountId: string },
  ): Promise<
    | { ok: true; session: SessionRecord }
    | { ok: false; code: SessionErrorCode; message: string }
  > {
    const db = this.dbHandle.db
    const { profileDir } = ensureProfileDir(this.options.profileRoot, key)
    try {
      const handle = await launchSession(profileDir, {
        headless: this.options.headless,
        executablePath: this.options.executablePath,
      })
      this.lives.set(created.id, {
        handle,
        sessionId: created.id,
        runPageIds: new Set(),
        runPages: new Map(),
      })
      const health = await probeHealth(handle)
      await setSessionProbe(db, {
        sessionId: created.id,
        ownerWorkerId: this.options.workerId,
        health,
      })
      const opened = await setSessionStatus(db, {
        sessionId: created.id,
        expectedVersion: created.version,
        status: 'OPEN',
        ownerWorkerId: this.options.workerId,
      })
      if (!opened) {
        await stopSession(handle)
        this.lives.delete(created.id)
        return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: '无法将会话置为 OPEN' }
      }
      const session = (await getSessionById(db, created.id))!
      return { ok: true, session }
    } catch (error) {
      await setSessionStatus(db, {
        sessionId: created.id,
        expectedVersion: created.version,
        status: 'CLOSED',
        closeReason: 'launch_failed',
        ownerWorkerId: this.options.workerId,
      }).catch(() => {})
      if (error instanceof BrowserRuntimeError) {
        return { ok: false, code: error.code, message: error.message }
      }
      throw error
    }
  }

  private async ensureAuth(
    session: SessionRecord,
    run: RunSnapshot,
    policy: SessionPolicy,
  ): Promise<
    | { ok: true; session: SessionRecord }
    | { ok: false; code: SessionErrorCode; message: string; waitingForAuth?: boolean }
  > {
    const db = this.dbHandle.db
    const live = this.lives.get(session.id)
    if (!live) {
      return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: '无浏览器句柄' }
    }

    const targetInfo = await this.loadTargetAuth(run.targetId)
    if (!targetInfo) {
      return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: '目标系统不存在' }
    }

    // 已认证则探针确认（不刷新 last_used_at）
    if (session.authState === 'AUTHENTICATED') {
      const auth = await probeAuth(live.handle, targetInfo)
      await setSessionProbe(db, {
        sessionId: session.id,
        ownerWorkerId: this.options.workerId,
        authState: auth,
      })
      if (auth === 'AUTHENTICATED') {
        return { ok: true, session: (await getSessionById(db, session.id))! }
      }
    }

    const missingFields =
      !targetInfo.loginFields?.username ||
      !targetInfo.loginFields?.password ||
      !targetInfo.loginFields?.submit

    const needsManual =
      targetInfo.authMethod === 'manual' || targetInfo.captchaMode !== 'none' || missingFields

    if (needsManual) {
      // 表 D7：manual / captcha / 缺 loginFields 均记 SESSION_AUTH_UNSUPPORTED 并等待人工
      const message =
        missingFields && targetInfo.authMethod === 'password' && targetInfo.captchaMode === 'none'
          ? '登录框定位不完整，无法自动登录'
          : targetInfo.authMethod === 'manual'
            ? '目标系统要求手工认证'
            : targetInfo.captchaMode !== 'none'
              ? '目标系统启用验证码，自动登录降级'
              : '需要人工认证'
      return this.enterWaitingForAuth(session, run, policy, 'SESSION_AUTH_UNSUPPORTED', message)
    }

    // password + none + 字段齐全 → 自动登录
    const credential = await this.resolveLoginCredential(run)
    if (!credential) {
      return this.enterWaitingForAuth(
        session,
        run,
        policy,
        'SESSION_AUTH_UNSUPPORTED',
        '无法解析登录凭据',
      )
    }

    const [account] = await db
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.id, run.targetAccountId!))
      .limit(1)
    const username = account?.username ?? credential.username
    const ok = await loginWithCredentials(live.handle, targetInfo, {
      username,
      password: credential.password,
    })
    const authState = ok ? 'AUTHENTICATED' : 'EXPIRED'
    await setSessionProbe(db, {
      sessionId: session.id,
      ownerWorkerId: this.options.workerId,
      health: 'HEALTHY',
      authState,
    })
    this.logger.log(
      { sessionId: session.id, authState, workerId: this.options.workerId, runId: run.runId },
      'session.auth_changed',
    )
    if (!ok) {
      return this.enterWaitingForAuth(
        session,
        run,
        policy,
        'SESSION_AUTH_UNSUPPORTED',
        '自动登录失败',
      )
    }
    await releaseAuthHold(db, { sessionId: session.id, workerId: this.options.workerId }).catch(
      () => {},
    )
    return { ok: true, session: (await getSessionById(db, session.id))! }
  }

  /**
   * 认证占用 + Run → WAITING_FOR_AUTH。不持有执行租约。
   */
  private async enterWaitingForAuth(
    session: SessionRecord,
    run: RunSnapshot,
    policy: SessionPolicy,
    code: SessionErrorCode,
    message: string,
  ): Promise<{ ok: false; code: SessionErrorCode; message: string; waitingForAuth: true }> {
    const db = this.dbHandle.db
    await claimAuthHold(db, {
      sessionId: session.id,
      workerId: this.options.workerId,
      holdSeconds: policy.authWaitSeconds,
    })
    await setSessionProbe(db, {
      sessionId: session.id,
      ownerWorkerId: this.options.workerId,
      authState: 'EXPIRED',
    })
    await markRunWaitingForAuth(db, run.runId)
    this.logger.log(
      { sessionId: session.id, runId: run.runId, workerId: this.options.workerId, code },
      'session.auth_changed',
    )
    return { ok: false, code, message, waitingForAuth: true }
  }

  private async resolveLoginCredential(
    run: RunSnapshot,
  ): Promise<{ username: string; password: string } | null> {
    if (this.resolveCredential) {
      return this.resolveCredential(run)
    }
    if (!run.secretRef || !this.secrets) return null
    if (run.secretRef.provider !== LOCAL_SECRET_PROVIDER) return null
    const row = await loadSecretCiphertext(this.dbHandle.db, run.secretRef.secretId)
    if (!row) return null
    try {
      const password = this.secrets.decrypt(row.id, row.ciphertext)
      const [account] = await this.dbHandle.db
        .select()
        .from(targetAccounts)
        .where(eq(targetAccounts.id, run.targetAccountId!))
        .limit(1)
      return { username: account?.username ?? '', password }
    } catch {
      return null
    }
  }

  private async loadTargetAuth(targetId: string): Promise<
    | (TargetAuthInfo & {
        authMethod: string
        captchaMode: string
      })
    | null
  > {
    const [row] = await this.dbHandle.db
      .select()
      .from(targets)
      .where(eq(targets.id, targetId))
      .limit(1)
    if (!row) return null
    return {
      entryUrl: row.entryUrl,
      loginUrl: row.loginUrl,
      loginFields: row.loginFields,
      authMethod: row.authMethod,
      captchaMode: row.captchaMode,
    }
  }

  private async applyReuse(
    session: SessionRecord,
    policy: SessionPolicy,
    leaseId: string,
  ): Promise<void> {
    const live = this.lives.get(session.id)
    if (!live) return
    if (pageStrategyForReuse(policy.reuse) === 'base') return
    const page = await openRunPage(live.handle)
    live.runPages.set(leaseId, page)
    live.runPageIds.add(leaseId)
  }

  private async closeRunPage(leaseId: string): Promise<void> {
    const sessionId = this.leaseToSession.get(leaseId)
    if (!sessionId) return
    const live = this.lives.get(sessionId)
    if (!live) return
    const page = live.runPages.get(leaseId)
    if (page) {
      await closePage(page)
      live.runPages.delete(leaseId)
      live.runPageIds.delete(leaseId)
    }
  }
}

export type { LeaseRecord }
