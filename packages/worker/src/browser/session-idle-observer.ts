import {
  appendSessionEvent,
  findActiveLeaseForSession,
  getPlatformConfig,
  getSessionById,
  loadCurrentAuthProfile,
  loadTargetForExecution,
  requestMaintenanceOperation,
} from '@cairn/db'
import {
  backgroundVerifyWindowSlot,
  FACTORY_SESSION_RETENTION,
  maintenanceIdempotencyKey,
  type AuthSignal,
} from '@cairn/shared'
import { observeRunAuthPage } from './run-auth-observer.js'
import type { SessionManagerContext } from './session-live.js'

export async function attachSessionAuthObserver(this: SessionManagerContext, sessionId: string): Promise<void> {
  const live = this.lives.get(sessionId)
  if (!live || live.authObserver || !live.handle.basePage) return
  const session = await getSessionById(this.dbHandle, sessionId)
  if (!session) return
  const target = await loadTargetForExecution(this.dbHandle, session.targetId)
  const profile = await loadCurrentAuthProfile(this.dbHandle, session.targetId)
  const observer = observeRunAuthPage({
    page: live.handle.basePage,
    loginUrl: target?.loginUrl ?? target?.entryUrl ?? null,
    definition: profile?.definition,
    onSignal: (signal) => {
      void handleSessionAuthSignal(this, sessionId, signal).catch((error) => {
        this.logger.warn(
          { sessionId, message: error instanceof Error ? error.message : String(error) },
          'session.auth_signal_failed',
        )
      })
    },
  })
  live.authObserver = observer
}

export async function handleSessionAuthSignal(
  manager: SessionManagerContext,
  sessionId: string,
  signal: AuthSignal,
): Promise<void> {
  const session = await getSessionById(manager.dbHandle, sessionId)
  if (!session || session.status !== 'OPEN') return
  const lease = await findActiveLeaseForSession(manager.dbHandle, sessionId)
  if (lease?.purpose === 'EXECUTION') {
    const current = manager.runAuth.get(lease.id) ?? {}
    manager.runAuth.set(lease.id, { ...current, pendingSignal: true })
    if (typeof manager.observeInRunAuth === 'function' && lease.id) {
      await manager
        .observeInRunAuth(
          {
            sessionId: lease.sessionId,
            leaseId: lease.id,
            generation: lease.sessionGeneration,
            sessionFencingToken: lease.sessionFencingToken,
            expiresAt: lease.expiresAt.toISOString(),
            purpose: 'EXECUTION',
            ownerKind: lease.ownerKind ?? 'RUN',
            runId: lease.runId,
          },
          'not_dispatched',
        )
        .catch((error) => {
          manager.logger.warn(
            { sessionId, message: error instanceof Error ? error.message : String(error) },
            'session.auth_signal_forward_failed',
          )
        })
    }
    return
  }
  await appendSessionEvent(manager.dbHandle, {
    key: { targetId: session.targetId, targetAccountId: session.targetAccountId },
    type: 'auth.signal_observed',
    sessionId: session.id,
    generation: session.generation,
    payload: { kind: signal.kind, summary: signal.summary },
  })
  const platform = await getPlatformConfig(manager.dbHandle)
  const fallbackInterval =
    platform?.document.sessionRetention.maintenanceIntervalSeconds ??
    FACTORY_SESSION_RETENTION.maintenanceIntervalSeconds
  const slot = backgroundVerifyWindowSlot(
    Date.now(),
    session.authProbeIntervalSeconds,
    fallbackInterval,
  )
  await requestMaintenanceOperation(manager.dbHandle, {
    key: { targetId: session.targetId, targetAccountId: session.targetAccountId },
    body: {
      kind: 'VERIFY_AUTH',
      idempotencyKey: maintenanceIdempotencyKey('bg-verify', session.targetAccountId, slot),
      expectedSessionId: session.id,
      expectedGeneration: session.generation,
    },
    origin: 'BACKGROUND',
  }).catch(() => undefined)
}
