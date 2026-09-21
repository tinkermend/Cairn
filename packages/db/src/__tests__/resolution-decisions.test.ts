import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { RESOLUTION_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL, type ResolutionDecision, type Step } from '@cairn/shared'
import { newId } from '../id.js'
import { expose } from '../database.js'
import { schemaFor } from '../native.js'
import { TargetsStore } from '../console/targets.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  appendResolutionDecision,
  claimRun,
  createRunWithSnapshot,
  createScenarioWithVersion,
  listResolutionDecisions,
  listResolutionStats,
  registerWorker,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

function clickStep(id: string): Step {
  return {
    id,
    name: '点击查询',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: {
      target: { framePath: [], candidates: [{ by: 'text', value: '查询' }] },
    },
  }
}

describe.each(DRIVERS)('%s 解析决策事实', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `res_dec_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'resolution-decisions',
      email: `res-${actorId}@example.com`,
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function readyWorker() {
    const workerId = `res-w-${newId()}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 2,
      lostAfterSeconds: 3600,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, RESOLUTION_PROTOCOL],
    })
    return { workerId, instanceId }
  }

  async function claimedAttempt() {
    const { targets } = schemaFor(handle.db)
    const targetId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `res-${targetId}`,
      name: '解析夹具',
      entryUrl: 'https://lab.example',
    })
    const step = clickStep(newId())
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `解析-${newId().slice(0, 8)}`,
      actor: { id: actorId },
      steps: [step],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.resolution).toBeUndefined()
    const worker = await readyWorker()
    const { runs } = schemaFor(handle.db)
    const all = await handle.db.select({ id: runs.id }).from(runs)
    const grant = await claimRun(handle, {
      ...worker,
      leaseTtlSeconds: 120,
      excludeRunIds: all.filter((row) => row.id !== created.detail.id).map((row) => row.id),
    })
    expect(grant?.runId).toBe(created.detail.id)
    const stepRun = created.detail.stepRuns[0]!
    const attemptId = newId()
    const { attempts } = schemaFor(handle.db)
    await handle.db.insert(attempts).values({
      id: attemptId,
      stepRunId: stepRun.id,
      attemptNo: 1,
      status: 'RUNNING',
      startedAt: new Date(),
    })
    return { created, grant: grant!, step, stepRun, attemptId, targetId, scenario }
  }

  function decision(input: {
    created: { detail: { id: string } }
    stepRun: { id: string }
    attemptId: string
    step: Step
    extras?: Partial<ResolutionDecision>
  }): ResolutionDecision {
    return {
      decisionId: newId(),
      runId: input.created.detail.id,
      stepRunId: input.stepRun.id,
      attemptId: input.attemptId,
      stepId: input.step.id,
      effectivePolicy: 'deterministic_only',
      rungs: [{ rung: 'D', outcome: 'FOUND', spentMs: 2 }],
      decision: 'deterministic',
      evidenceRefs: [],
      ...input.extras,
    }
  }

  it('同一 Attempt 恰好一条决策，同载荷可重放，不同载荷冲突', async () => {
    const ctx = await claimedAttempt()
    const first = decision(ctx)
    const saved = await appendResolutionDecision(handle.db, { grant: ctx.grant, decision: first })
    expect(await appendResolutionDecision(handle.db, { grant: ctx.grant, decision: { ...first, decisionId: newId() } })).toEqual(
      saved,
    )
    await expect(
      appendResolutionDecision(handle.db, {
        grant: ctx.grant,
        decision: { ...first, decision: 'failed', reasonCode: 'TARGET_NOT_FOUND' },
      }),
    ).rejects.toMatchObject({ code: 'RESOLUTION_IDEMPOTENCY_CONFLICT' })
    const listed = await listResolutionDecisions(handle.db, ctx.created.detail.id, { limit: 20 })
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.decision).toBe('deterministic')
  })

  it('过期租约不能写；统计按步骤聚合且 failed 单列', async () => {
    const ctx = await claimedAttempt()
    const first = decision(ctx)
    await appendResolutionDecision(handle.db, { grant: ctx.grant, decision: first })
    const { runLeases } = schemaFor(handle.db)
    await handle.db.update(runLeases).set({ expiresAt: new Date(0) }).where(eq(runLeases.id, ctx.grant.leaseId))
    await expect(
      appendResolutionDecision(handle.db, {
        grant: ctx.grant,
        decision: decision({ ...ctx, extras: { decisionId: newId(), decision: 'ai' } }),
      }),
    ).rejects.toMatchObject({ code: 'RESOLUTION_FACT_STALE_OWNER' })

    const secondAttempt = newId()
    const { attempts } = schemaFor(handle.db)
    await handle.db.insert(attempts).values({
      id: secondAttempt,
      stepRunId: ctx.stepRun.id,
      attemptNo: 2,
      status: 'RUNNING',
      startedAt: new Date(),
    })
    await handle.db
      .update(runLeases)
      .set({ expiresAt: new Date(Date.now() + 120_000) })
      .where(eq(runLeases.id, ctx.grant.leaseId))
    await appendResolutionDecision(handle.db, {
      grant: ctx.grant,
      decision: decision({
        ...ctx,
        attemptId: secondAttempt,
        extras: { decision: 'failed', reasonCode: 'TARGET_NOT_FOUND', rungs: [{ rung: 'D', outcome: 'TARGET_NOT_FOUND', spentMs: 4 }] },
      }),
    })
    const stats = await listResolutionStats(handle.db, ctx.scenario.id, {})
    const row = stats.items.find((item) => item.stepId === ctx.step.id)
    expect(row).toMatchObject({
      deterministic: 1,
      map: 0,
      ai: 0,
      failed: 1,
      fallbackRate: 0,
    })
  })

  it('目标解析策略可读写，清除后回到继承平台', async () => {
    const { targets } = schemaFor(handle.db)
    const targetId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `res-pol-${targetId}`,
      name: '解析策略夹具',
      entryUrl: 'https://lab.example',
    })
    const store = new TargetsStore(expose(handle), () => Buffer.from('unused'))
    const initial = await store.getTarget(targetId)
    expect(initial.resolutionPolicy).toBeNull()
    expect(initial.effectiveResolution?.preference).toBe('prefer_deterministic')
    expect(initial.effectiveResolution?.ceiling).toBe('deterministic_only')
    const updated = await store.updateResolutionPolicy(
      targetId,
      { preference: 'prefer_ai', ceiling: 'deterministic_only' },
      { id: actorId },
    )
    expect(updated.resolutionPolicy).toEqual({
      preference: 'prefer_ai',
      ceiling: 'deterministic_only',
    })
    expect(updated.effectiveResolution).toEqual({
      preference: 'prefer_ai',
      ceiling: 'deterministic_only',
    })
    const cleared = await store.updateResolutionPolicy(
      targetId,
      { preference: null, ceiling: null },
      { id: actorId },
    )
    expect(cleared.resolutionPolicy).toBeNull()
  })
})
