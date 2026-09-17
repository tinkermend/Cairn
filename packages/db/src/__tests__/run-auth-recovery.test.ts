import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FACTORY_RUN_AUTH_RECOVERY,
  NO_RUN_AUTH_RECOVERY,
  SESSION_OCCUPANCY_PROTOCOL,
  computeContextVersion,
  type AuthCheckpoint,
  type Step,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  acquireAuthControl,
  resumeRunAfterAuth,
  createSession,
  findAuthWaitLeaseForRun,
  findLiveSession,
  eq,
  createRunWithSnapshot,
  createScenarioWithVersion,
  finishAttempt,
  getRun,
  getSessionById,
  requestRunCancel,
  reapSessionLeases,
  registerWorker,
  countFailedRecoveries,
  startAttempt,
  writeRunAuthCheckpoint,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'
import { forceGrantForRun, seedWorker, enterAuthWaitForRun } from './lease-harness.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000d1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

function checkpoint(run: { snapshot: { steps: { id: string }[] } }, extra: Partial<AuthCheckpoint> = {}): AuthCheckpoint {
  return {
    schemaVersion: 1,
    status: 'closed',
    closedAt: '2026-09-16T04:00:00.000Z',
    trigger: { kind: 'navigated_to_login', at: '2026-09-16T04:00:00.000Z', summary: '/login' },
    nextStepId: run.snapshot.steps[0]!.id,
    nextOrdinal: 0,
    interruptedClassification: 'not_dispatched',
    contextVersion: 'a'.repeat(64),
    contextKeys: [],
    sessionGeneration: 1,
    fencingToken: '1',
    recoveryRule: {
      reuse: 'NEW_PAGE',
      entryUrl: 'https://example.com/',
      allowedOrigins: ['https://example.com'],
    },
    capability: 'IDENTITY_VERIFIED',
    autoRecoveriesUsed: 0,
    manualRecoveriesUsed: 0,
    ...extra,
  }
}

describe.each(DRIVERS)('%s 运行中认证检查点', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `cairn_test_${Date.now().toString(36)}_authrec`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'tester',
      email: `authrec-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `authrec-${targetId}`,
      name: '恢复夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('新 Run 冻结平台 runAuthRecovery；检查点与 Attempt 同事务', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `auth-rec-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.runAuthRecovery).toEqual(FACTORY_RUN_AUTH_RECOVERY)
    expect(created.detail.authCheckpoint ?? null).toBeNull()

    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    const closed = checkpoint(created.detail, { interruptedAttemptId: started!.attemptId, fencingToken: String(grant.fencingToken) })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'FAILED',
      error: { code: 'AUTH_GATE_CLOSED', category: 'INFRASTRUCTURE', retryable: false, safeMessage: '登录已失效' },
      stepRunStatus: 'RUNNING',
      authCheckpoint: closed,
      grant,
    })
    const after = await getRun(handle.db, created.detail.id)
    expect(after.authCheckpoint).toMatchObject({ status: 'closed', interruptedClassification: 'not_dispatched' })
    expect(after.status).toBe('RUNNING')
    expect(after.stepRuns[0]!.attempts[0]!.status).toBe('FAILED')

    const written = await writeRunAuthCheckpoint(handle.db, {
      runId: created.detail.id,
      grant,
      checkpoint: { ...closed, status: 'recovering', recoveryKind: 'auto', autoRecoveriesUsed: 1 },
    })
    expect(written).toBe(true)
    expect((await getRun(handle.db, created.detail.id)).authCheckpoint?.status).toBe('recovering')
  })

  it('修改平台次数后只冻结新 Run（SM44D）', async () => {
    const current = await getOrCreatePlatformConfig(handle.db)
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      reason: '测试恢复次数为 0',
      document: { ...current.document, runAuthRecovery: NO_RUN_AUTH_RECOVERY },
      actor: { id: actorId },
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `auth-rec-zero-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.runAuthRecovery).toEqual(NO_RUN_AUTH_RECOVERY)
  })
  async function manualRecovery() {
    const { targetAccounts, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    if (!admin) throw new Error('missing admin role fixture')
    const existing = await handle.db.select().from(consoleAccountRoles).where(eq(consoleAccountRoles.consoleAccountId, actorId))
    if (!existing.length) await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin.id })
    const accountId = newId()
    await handle.db.insert(targetAccounts).values({ id: accountId, targetId, username: `alice-${accountId}`, displayName: 'account', status: 'active' })
    const current = await getOrCreatePlatformConfig(handle.db)
    await updatePlatformConfig(handle.db, { expectedRevision: current.revision, reason: 'manual fixture', document: { ...current.document, runAuthRecovery: FACTORY_RUN_AUTH_RECOVERY }, actor: { id: actorId } })
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: `manual-${accountId}`, steps: [echoStep], actor: { id: actorId } })
    const created = await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, targetAccountId: accountId, actor: { id: actorId } })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    await enterAuthWaitForRun(handle, { targetId, targetAccountId: accountId, grant, ...worker, holdSeconds: 600 })
    const session = (await findLiveSession(handle.db, { targetId, targetAccountId: accountId }))!
    const cp = checkpoint(created.detail, { status: 'recovering', recoveryKind: 'manual', manualRecoveriesUsed: 1, sessionGeneration: session.generation, contextVersion: await computeContextVersion(created.detail.context) })
    await writeRunAuthCheckpoint(handle.db, { runId: created.detail.id, recover: true, checkpoint: cp })
    const control = await acquireAuthControl(handle.db, { sessionId: session.id, runId: created.detail.id, actor: { id: actorId }, workerId: worker.workerId, workerInstanceId: worker.instanceId, sessionGeneration: session.generation })
    const request = { sessionId: session.id, runId: created.detail.id, actor: { id: actorId }, workerId: worker.workerId, workerInstanceId: worker.instanceId, controlEpoch: control.epoch, token: control.token, recoveredAuthCheckpoint: { ...cp, status: 'recovered' as const } }
    return { session, request }
  }

  it('人工恢复完成与检查点同事务，缺令牌时不释放 AUTH_WAIT', async () => {
    const { request } = await manualRecovery()
    await expect(resumeRunAfterAuth(handle.db, { ...request, token: undefined })).rejects.toMatchObject({ code: 'AUTH_CONTROL_INVALID' })
    expect((await getRun(handle.db, request.runId)).authCheckpoint?.status).toBe('recovering')
    expect(await findAuthWaitLeaseForRun(handle.db, request.runId)).not.toBeNull()
    await resumeRunAfterAuth(handle.db, request)
    const row = await getRun(handle.db, request.runId)
    expect(row.status).toBe('RECOVERING')
    expect(row.authCheckpoint?.status).toBe('recovered')
    expect(await findAuthWaitLeaseForRun(handle.db, request.runId)).toBeNull()
  })

  it('完成认证时拒绝 context 已变化或控制已过期', async () => {
    const { request, session } = await manualRecovery()
    const { runs, browserSessions } = schemaFor(handle.db)
    await handle.db.update(runs).set({ context: { changed: true } }).where(eq(runs.id, request.runId))
    await expect(resumeRunAfterAuth(handle.db, request)).rejects.toMatchObject({ code: 'AUTH_CONTEXT_NOT_RECOVERABLE' })
    await handle.db.update(runs).set({ context: {} }).where(eq(runs.id, request.runId))
    await handle.db.update(browserSessions).set({ authControlExpiresAt: new Date(0) }).where(eq(browserSessions.id, session.id))
    await expect(resumeRunAfterAuth(handle.db, request)).rejects.toMatchObject({ code: 'AUTH_CONTROL_INVALID' })
    expect((await getRun(handle.db, request.runId)).status).toBe('WAITING_FOR_AUTH')
  })

  it('AH-03 取消没有 AUTH_WAIT 租约的 Run 不改动任何 browser_sessions 行', async () => {
    const { targetAccounts, browserSessions } = schemaFor(handle.db)
    const accountId = newId()
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      username: `ah03-${accountId.slice(0, 8)}`,
      displayName: 'ah03',
      status: 'active',
    })
    const createdSession = await createSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: 'ah03-sentinel',
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 60,
      maxLifetimeSeconds: 600,
    })
    if (!createdSession.ok) throw new Error(createdSession.message)
    const fingerprint = async () => {
      const rows = await handle.db.select().from(browserSessions)
      return rows
        .map((row) => ({
          id: row.id,
          status: row.status,
          version: row.version,
          updatedAt: row.updatedAt.toISOString(),
          authControlEpoch: row.authControlEpoch,
          authControlActorId: row.authControlActorId,
          authControlTokenHash: row.authControlTokenHash,
          authControlExpiresAt: row.authControlExpiresAt?.toISOString() ?? null,
          authControlPageId: row.authControlPageId,
          ownerWorkerId: row.ownerWorkerId,
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    }
    const before = await fingerprint()
    expect(before.length).toBeGreaterThan(0)
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `ah03-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const queued = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(await findAuthWaitLeaseForRun(handle.db, queued.detail.id)).toBeNull()
    await requestRunCancel(handle.db, queued.detail.id, { id: actorId })
    expect((await getRun(handle.db, queued.detail.id)).status).toBe('CANCELLED')
    expect(await fingerprint()).toEqual(before)
  })

  it('取消等待认证的 Run 同事务释放占用及控制权，迟到完成不能复活 Run', async () => {
    const { request, session } = await manualRecovery()
    await requestRunCancel(handle.db, request.runId, { id: actorId })
    expect((await getRun(handle.db, request.runId)).status).toBe('CANCELLED')
    expect(await findAuthWaitLeaseForRun(handle.db, request.runId)).toBeNull()
    expect(await getSessionById(handle.db, session.id)).toMatchObject({
      authControlTokenHash: null,
      authControlActorId: null,
    })
    await expect(resumeRunAfterAuth(handle.db, request)).rejects.toMatchObject({ code: 'RUN_NOT_WAITING_FOR_AUTH' })
  })

  it('取消与超时回收并发不死锁，终态均释放控制权', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { request, session } = await manualRecovery()
      const { sessionLeases } = schemaFor(handle.db)
      const lease = (await findAuthWaitLeaseForRun(handle.db, request.runId))!
      await handle.db.update(sessionLeases).set({ waitDeadlineAt: new Date(0) }).where(eq(sessionLeases.id, lease.id))
      await Promise.all([
        requestRunCancel(handle.db, request.runId, { id: actorId }),
        reapSessionLeases(handle.db),
      ])
      expect(['CANCELLED', 'FAILED']).toContain((await getRun(handle.db, request.runId)).status)
      expect(await findAuthWaitLeaseForRun(handle.db, request.runId)).toBeNull()
      expect((await getSessionById(handle.db, session.id))?.authControlTokenHash).toBeNull()
    }
  })

  it('取消与完成认证并发不死锁，完成不能复活已取消 Run', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { request, session } = await manualRecovery()
      const [cancelled, resumed] = await Promise.allSettled([
        requestRunCancel(handle.db, request.runId, { id: actorId }),
        resumeRunAfterAuth(handle.db, request),
      ])
      expect(cancelled.status).toBe('fulfilled')
      if (resumed.status === 'rejected') {
        expect(resumed.reason).toMatchObject({ code: 'RUN_NOT_WAITING_FOR_AUTH' })
      }
      expect((await getRun(handle.db, request.runId)).status).toBe('CANCELLED')
      expect(await findAuthWaitLeaseForRun(handle.db, request.runId)).toBeNull()
      expect((await getSessionById(handle.db, session.id))?.authControlTokenHash).toBeNull()
    }
  })

  it('同 ID Worker 换代后 AUTH_WAIT 仍由统一回收器收束，不能遗留等待 Run', async () => {
    const { request, session } = await manualRecovery()
    const { workers } = schemaFor(handle.db)
    await handle.db.update(workers).set({ heartbeatExpiresAt: new Date(0), status: 'LOST' }).where(eq(workers.id, request.workerId))
    await registerWorker(handle.db, { workerId: request.workerId, instanceId: newId(), capacity: 4, lostAfterSeconds: 60, protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL] })
    expect((await getSessionById(handle.db, session.id))?.status).toBe('LOST')
    expect((await getSessionById(handle.db, session.id))?.authControlTokenHash).toBeNull()
    await reapSessionLeases(handle.db)
    expect(await findAuthWaitLeaseForRun(handle.db, request.runId)).toBeNull()
    expect(await countFailedRecoveries(handle.db, request.runId)).toBe(1)
    expect((await getRun(handle.db, request.runId)).status).toBe('RECOVERING')
    await expect(resumeRunAfterAuth(handle.db, request)).rejects.toMatchObject({ code: 'WORKER_GENERATION_MISMATCH' })
  })

})
