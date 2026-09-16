import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { enterAuthWaitForRun, forceGrantForRun, seedWorker } from './lease-harness.js'
import {
  acquireAuthControl,
  createRunWithSnapshot,
  createScenarioWithVersion,
  DomainError,
  markRunWaitingForAuth,
  findSessionByAuthHoldRun,
  getRun,
  getSessionById,
  heartbeatAuthControl,
  setSessionProbe,
  setSessionStatus,
  listExpiredAuthHolds,
  listRunsWaitingForAuthByAccount,
  releaseAuthControl,
  requireCreatedSession,
  resumeRunAfterAuth,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_authctl`

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s AuthHold / AuthControl 原子性', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let otherActorId: string
  let targetId: string
  let accountId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    const { consoleAccounts, targets, targetAccounts } = schemaFor(handle.db)
    actorId = newId()
    otherActorId = newId()
    targetId = newId()
    accountId = newId()
    await handle.db.insert(consoleAccounts).values([
      { id: actorId, displayName: 'auth-a', email: `a-${actorId}@example.com`, status: 'active' },
      { id: otherActorId, displayName: 'auth-b', email: `b-${otherActorId}@example.com`, status: 'active' },
    ])
    await handle.db.insert(targets).values({
      id: targetId,
      code: `auth-${SCHEMA.slice(-6)}`,
      name: '认证夹具',
      entryUrl: 'https://example.com',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '账号',
      username: 'alice',
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle.close()
  })

  async function queueRun() {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `auth-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    return createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
  }

  async function openSession(workerId: string, instanceId?: string) {
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      reusePolicy: 'REUSE_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    await setSessionProbe(handle.db, {
      sessionId: session.id,
      ownerWorkerId: workerId,
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
    })
    return (await getSessionById(handle.db, session.id))!
  }

  async function closeSession(sessionId: string, workerId: string) {
    const current = await getSessionById(handle.db, sessionId)
    if (!current || current.status === 'CLOSED') return
    await setSessionStatus(handle.db, {
      sessionId,
      expectedVersion: current.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: workerId,
    })
  }

  it('进入等待是单事务：hold 绑定 Run 并释放执行租约', async () => {
    const created = await queueRun()
    const worker = await seedWorker(handle, `wait-${newId().slice(0, 8)}`)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const { claimed, waitGrant } = await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: accountId,
      grant,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      holdSeconds: 120,
    })
    expect(waitGrant.purpose).toBe('AUTH_WAIT')
    const run = await getRun(handle.db, created.detail.id)
    expect(run.status).toBe('WAITING_FOR_AUTH')
    expect(run.lease).toBeNull()
    const held = await findSessionByAuthHoldRun(handle.db, created.detail.id)
    expect(held?.id).toBe(claimed.session.id)
    expect(held?.authState).toBe('UNKNOWN')
    await closeSession(claimed.session.id, worker.workerId)
  })

  it('只改 Run 状态、不写绑定 hold 时不能授输入权', async () => {
    const created = await queueRun()
    const worker = await seedWorker(handle, `bare-wait-${newId().slice(0, 8)}`)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const session = await openSession(worker.workerId, worker.instanceId)
    expect(await markRunWaitingForAuth(handle.db, grant)).toBe(true)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('WAITING_FOR_AUTH')
    await expect(
      acquireAuthControl(handle.db, {
        sessionId: session.id,
        runId: created.detail.id,
        actor: { id: actorId },
        workerId: worker.workerId,
        workerInstanceId: worker.instanceId,
        sessionGeneration: session.generation,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_HOLD_UNBOUND' })
    await closeSession(session.id, worker.workerId)
  })

  it('未绑定 hold 不能授输入权；两人不能同时持有', async () => {
    const created = await queueRun()
    const worker = await seedWorker(handle, `ctl-${newId().slice(0, 8)}`)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const session = await openSession(worker.workerId, worker.instanceId)
    await expect(
      acquireAuthControl(handle.db, {
        sessionId: session.id,
        runId: created.detail.id,
        actor: { id: actorId },
        workerId: worker.workerId,
        workerInstanceId: worker.instanceId,
        sessionGeneration: session.generation,
      }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_WAITING_FOR_AUTH' })

    const { claimed, waitGrant } = await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: accountId,
      grant,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      holdSeconds: 120,
    })
    expect(waitGrant.purpose).toBe('AUTH_WAIT')
    const waiting = (await getSessionById(handle.db, claimed.session.id))!
    const first = await acquireAuthControl(handle.db, {
      sessionId: waiting.id,
      runId: created.detail.id,
      actor: { id: actorId },
      workerId: worker.workerId,
      workerInstanceId: worker.instanceId,
      sessionGeneration: waiting.generation,
    })
    expect(first.token.length).toBeGreaterThan(16)
    await expect(
      acquireAuthControl(handle.db, {
        sessionId: waiting.id,
        runId: created.detail.id,
        actor: { id: otherActorId },
        workerId: worker.workerId,
        workerInstanceId: worker.instanceId,
        sessionGeneration: waiting.generation,
      }),
    ).rejects.toBeInstanceOf(DomainError)
    const beat = await heartbeatAuthControl(handle.db, {
      sessionId: waiting.id,
      runId: created.detail.id,
      actorId,
      token: first.token,
      workerInstanceId: worker.instanceId,
    })
    expect(beat.epoch).toBe(first.epoch)
    expect(
      await releaseAuthControl(handle.db, {
        sessionId: waiting.id,
        runId: created.detail.id,
        actor: { id: actorId },
        token: first.token,
      }),
    ).toBe(true)
    await closeSession(waiting.id, worker.workerId)
  })

  it('resume 必须匹配 hold/epoch；未绑定不能只靠状态恢复', async () => {
    const created = await queueRun()
    const worker = await seedWorker(handle, `res-${newId().slice(0, 8)}`)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const { claimed } = await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: accountId,
      grant,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      holdSeconds: 120,
    })
    const session = (await getSessionById(handle.db, claimed.session.id))!
    const control = await acquireAuthControl(handle.db, {
      sessionId: session.id,
      runId: created.detail.id,
      actor: { id: actorId },
      workerId: worker.workerId,
      workerInstanceId: worker.instanceId,
      sessionGeneration: session.generation,
    })
    await expect(
      resumeRunAfterAuth(handle.db, {
        runId: created.detail.id,
        actor: { id: actorId },
        sessionId: session.id,
        workerId: worker.workerId,
        workerInstanceId: worker.instanceId,
        controlEpoch: control.epoch - 1,
        token: control.token,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_CONTROL_INVALID' })
    await resumeRunAfterAuth(handle.db, {
      runId: created.detail.id,
      actor: { id: actorId },
      sessionId: session.id,
      workerId: worker.workerId,
      workerInstanceId: worker.instanceId,
      controlEpoch: control.epoch,
      token: control.token,
    })
    expect((await getRun(handle.db, created.detail.id)).status).toBe('RECOVERING')
    expect(await findSessionByAuthHoldRun(handle.db, created.detail.id)).toBeNull()
    expect(await listRunsWaitingForAuthByAccount(handle.db, accountId)).not.toContain(created.detail.id)
    expect(await listExpiredAuthHolds(handle.db, worker.workerId)).toEqual([])
    await closeSession(session.id, worker.workerId)
  })

  it('缺少 Worker 绑定字段的 resume 不能只靠状态恢复', async () => {
    const created = await queueRun()
    const worker = await seedWorker(handle, `bare-${newId().slice(0, 8)}`)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const { claimed } = await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: accountId,
      grant,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      holdSeconds: 120,
    })
    await expect(
      resumeRunAfterAuth(handle.db, {
        runId: created.detail.id,
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_HOLD_UNBOUND' })
    expect((await getRun(handle.db, created.detail.id)).status).toBe('WAITING_FOR_AUTH')
    await closeSession(claimed.session.id, worker.workerId)
  })
})
