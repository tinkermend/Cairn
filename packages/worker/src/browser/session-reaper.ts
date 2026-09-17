import {
  isolateOrphanedSessions,
  occupancyGrantFromLease,
  reapSessionLeases,
  getSessionById,
  listOwnedLiveSessions,
  listReapableSessions,
  listRequestedCloseSessions,
  markSessionsClosing,
  releaseSessionUse,
  renewSessionUse,
  setSessionProbe,
  setSessionStatus,
  appendSessionEvent
} from '@cairn/db'
import { DEFAULT_SESSION_POLICY, type SessionPolicy } from '@cairn/shared'
import { closePage, probeHealth, stopSession } from './runtime'
import { SessionLeaseError, type SessionManagerContext } from './session-live.js'

export function ownerScope(this: SessionManagerContext) {
    return {
      ownerWorkerId: this.options.workerId,
      ownerWorkerInstanceId: this.workerInstanceId,
    }
  }

export async function dropLocalHandle(this: SessionManagerContext, sessionId: string): Promise<'stopped' | 'unconfirmed'> {
    const live = this.lives.get(sessionId)
    if (!live) return 'unconfirmed'
    live.authObserver?.dispose()
    live.authObserver = undefined
    live.screencastObservers.clear()
    for (const cast of live.screencasts.values()) {
      await cast.stop().catch(() => undefined)
    }
    for (const page of live.runPages.values()) {
      await closePage(page)
    }
    if (live.lastPage && live.lastPage !== live.handle.basePage && !live.lastPage.isClosed()) {
      await closePage(live.lastPage)
    }
    const stopResult = await stopSession(live.handle)
    this.lives.delete(sessionId)
    for (const [leaseId, mapped] of [...this.leaseToSession.entries()]) {
      if (mapped === sessionId) {
        this.leaseToSession.delete(leaseId)
        this.leaseToRun.delete(leaseId)
        this.leaseTtls.delete(leaseId)
      }
    }
    return stopResult
  }

export async function reconcileOwn(this: SessionManagerContext): Promise<{ leasesRevoked: number; sessionsClosed: number }> {
    if (this.reconciled) {
      return { leasesRevoked: 0, sessionsClosed: 0 }
    }
    const db = this.dbHandle
    const sessionsClosed = await isolateOrphanedSessions(db, this.options.workerId, this.workerInstanceId)
    this.reconciled = true
    this.logger.log(
      { workerId: this.options.workerId, instanceId: this.workerInstanceId, sessionsClosed },
      'session.reconcile_own',
    )
    return { leasesRevoked: 0, sessionsClosed }
  }

export async function renew(this: SessionManagerContext, leaseId: string, leaseTtlSeconds?: number): Promise<'ok' | 'lost'> {
    const ttl =
      leaseTtlSeconds ?? this.leaseTtls.get(leaseId) ?? this.options.defaultLeaseTtlSeconds
    const row = await renewSessionUse(this.dbHandle, {
      leaseId,
      holderWorkerId: this.options.workerId,
      leaseTtlSeconds: ttl,
    })
    if (!row) {
      this.guard.revoke(leaseId)
      this.leaseTtls.delete(leaseId)
      this.logger.warn({ leaseId, workerId: this.options.workerId }, 'lease.renew_failed')
      return 'lost'
    }
    this.guard.refresh(occupancyGrantFromLease(row))
    return 'ok'
  }

export async function release(this: SessionManagerContext, leaseId: string, reason: string): Promise<void> {
    const sessionId = this.leaseToSession.get(leaseId)
    await this.stopTracingForLease(leaseId, sessionId)
    await this.closeRunPage(leaseId)
    const result = await releaseSessionUse(this.dbHandle, {
      leaseId,
      holderWorkerId: this.options.workerId,
      reason,
    })
    this.guard.revoke(leaseId)
    this.leaseToSession.delete(leaseId)
    this.leaseToRun.delete(leaseId)
    this.leaseTtls.delete(leaseId)
    if (result === 'unknown') {
      throw new SessionLeaseError('SESSION_LEASE_UNKNOWN', `租约不存在: ${leaseId}`)
    }
    this.logger.log(
      { leaseId, sessionId, reason, result, workerId: this.options.workerId },
      'lease.released',
    )
  }

export async function close(this: SessionManagerContext, sessionId: string, reason: string): Promise<'stopped' | 'unconfirmed'> {
    const db = this.dbHandle
    const session = await getSessionById(db, sessionId)
    if (!session) return 'unconfirmed'
    if (session.ownerWorkerId !== this.options.workerId) {
      return this.dropLocalHandle(sessionId)
    }
    if (!session.ownerWorkerInstanceId || session.ownerWorkerInstanceId !== this.workerInstanceId) {
      return this.dropLocalHandle(sessionId)
    }

    this.logger.log(
      { sessionId, generation: session.generation, reason, workerId: this.options.workerId },
      'session.closing',
    )
    await setSessionStatus(db, {
      sessionId,
      expectedVersion: session.version,
      status: 'CLOSING',
      closeReason: reason,
      ...this.ownerScope(),
    })

    const live = this.lives.get(sessionId)
    let stopResult: 'stopped' | 'unconfirmed' = 'stopped'
    if (live) {
      stopResult = await this.dropLocalHandle(sessionId)
    } else {
      // 无本进程句柄：无法确认浏览器是否仍在 → LOST（阻塞键）
      stopResult = 'unconfirmed'
    }

    const latest = await getSessionById(db, sessionId)
    if (!latest || latest.ownerWorkerInstanceId !== this.workerInstanceId) return stopResult
    if (stopResult === 'stopped') {
      await setSessionStatus(db, {
        sessionId,
        expectedVersion: latest.version,
        status: 'CLOSED',
        closeReason: reason,
        ...this.ownerScope(),
      })
      this.logger.log({ sessionId, reason, workerId: this.options.workerId }, 'session.closed')
      if (reason === 'capacity_evict') {
        await appendSessionEvent(db, {
          key: { targetId: session.targetId, targetAccountId: session.targetAccountId },
          type: 'session.evicted',
          sessionId,
          generation: session.generation,
          payload: {
            closeReason: 'capacity_evict',
            ownerWorkerId: this.options.workerId,
            evictedSessionId: sessionId,
          },
        }).catch(() => undefined)
      }
    } else {
      await setSessionStatus(db, {
        sessionId,
        expectedVersion: latest.version,
        status: 'LOST',
        closeReason: reason,
        ...this.ownerScope(),
      })
      this.logger.warn({ sessionId, reason, workerId: this.options.workerId }, 'session.lost')
    }
    return stopResult
  }

export async function reap(this: SessionManagerContext): Promise<{
    leasesExpired: number
    sessionsClosed: number
  }> {
    this.browserUnavailable = false
    const db = this.dbHandle
    const leasesExpired = await reapSessionLeases(db)
    if (leasesExpired > 0) {
      this.logger.log({ leasesExpired, workerId: this.options.workerId }, 'lease.expired')
    }

    // 控制面可能已处置掉本进程的卡死会话（例如 LOST 后人工放行）。句柄若还在，
    // 必须停掉浏览器——否则旧进程带着同一 profile 活着，正是处置要消除的双开风险。
    const disposedDropped = await this.dropDisposedHandles()

    const reapable = await listReapableSessions(db, this.options.workerId)
    if (reapable.length > 0) {
      await markSessionsClosing(db, {
        workerId: this.options.workerId,
        ownerWorkerInstanceId: this.workerInstanceId,
        sessionIds: reapable.map((s) => s.id),
        reason: 'idle_or_max_lifetime',
      })
    }
    const requestedClose = await listRequestedCloseSessions(db, this.options.workerId)

    let sessionsClosed = 0
    for (const session of reapable) {
      await this.close(session.id, 'idle_or_max_lifetime')
      sessionsClosed += 1
    }
    for (const session of requestedClose) {
      await this.close(session.id, session.closeReason ?? 'resource_deleted')
      sessionsClosed += 1
    }

    // 健康探针：对本进程活句柄探测，不刷新 last_used_at
    for (const [sessionId, live] of this.lives) {
      const health = await probeHealth(live.handle)
      await setSessionProbe(db, {
        sessionId,
        ...this.ownerScope(),
        health,
      })
      if (health === 'UNHEALTHY') {
        await this.close(sessionId, 'unhealthy')
        sessionsClosed += 1
      }
    }

    this.logger.log(
      { leasesExpired, sessionsClosed, disposedDropped, workerId: this.options.workerId },
      'reap.cycle',
    )
    return { leasesExpired, sessionsClosed }
  }

export async function dropDisposedHandles(this: SessionManagerContext): Promise<number> {
    const db = this.dbHandle
    let dropped = 0
    for (const [sessionId, live] of [...this.lives]) {
      const row = await getSessionById(db, sessionId)
      const stillOurs =
        row !== null && row.status !== 'CLOSED' && row.ownerWorkerId === this.options.workerId
      if (stillOurs) continue

      for (const page of live.runPages.values()) await closePage(page)
      if (live.lastPage && live.lastPage !== live.handle.basePage && !live.lastPage.isClosed()) {
        await closePage(live.lastPage)
      }
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

export async function shutdown(this: SessionManagerContext): Promise<void> {
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

export function platformDefaultPolicy(this: SessionManagerContext): SessionPolicy {
    return {
      ...DEFAULT_SESSION_POLICY,
      leaseTtlSeconds: this.options.defaultLeaseTtlSeconds,
    }
  }

export async function renewAll(this: SessionManagerContext): Promise<void> {
    for (const leaseId of [...this.leaseToSession.keys()]) {
      const result = await this.renew(leaseId)
      if (result === 'lost') {
        await this.closeRunPage(leaseId)
        this.leaseToSession.delete(leaseId)
        this.leaseToRun.delete(leaseId)
        this.leaseTtls.delete(leaseId)
      }
    }
  }

export async function stopAllLocal(this: SessionManagerContext): Promise<Array<{ sessionId: string; result: 'stopped' | 'unconfirmed' }>> {
    const owned = await listOwnedLiveSessions(this.dbHandle, this.options.workerId)
    const ids = new Set<string>([...this.lives.keys(), ...owned.map((session) => session.id)])
    const results: Array<{ sessionId: string; result: 'stopped' | 'unconfirmed' }> = []
    for (const sessionId of ids) {
      await this.close(sessionId, 'owner_confirmed_stopped')
      const latest = await getSessionById(this.dbHandle, sessionId)
      results.push({
        sessionId,
        result: latest?.status === 'CLOSED' ? 'stopped' : 'unconfirmed',
      })
    }
    return results
  }

