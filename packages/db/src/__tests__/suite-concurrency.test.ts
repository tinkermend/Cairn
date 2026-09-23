import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_OCCUPANCY_PROTOCOL, SUITE_ADMISSION_PROTOCOL, type Step } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  advanceSuiteRun,
  claimRun,
  createScenarioWithVersion,
  createSuite,
  createSuiteRun,
  getSuiteRunObservation,
  publishSuite,
  registerWorker,
  scheduleSuiteAdvanceForChild,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const echo: Step = {
  id: '00000000-0000-4000-8000-0000000000e1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'test' },
}

describe.each(DRIVERS)('%s 场景集并发调度与账号互斥', { timeout: 90_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `suite_conc_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'suite-admin',
      email: `admin-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({
      consoleAccountId: actorId,
      consoleRoleId: admin!.id,
      targetScopeMode: 'all',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  beforeEach(async () => {
    const { runs, browserSessions } = schemaFor(handle.db)
    await handle.db.update(browserSessions).set({ status: 'CLOSED', closedAt: new Date(), closeReason: 'cleanup' })
    await handle.db.update(runs).set({ status: 'CANCELLED', finishedAt: new Date() })
  })

  async function seedTargetWithScenarios(count = 3) {
    const { targets } = schemaFor(handle.db)
    const targetId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `target-${targetId}`,
      name: '并发测试目标',
      entryUrl: 'https://example.com',
    })
    const scenarios = []
    for (let i = 0; i < count; i++) {
      const scenario = await createScenarioWithVersion(handle.db, {
        targetId,
        name: `场景-${i + 1}`,
        steps: [{ ...echo, id: `00000000-0000-4000-8000-0000000000e${i + 1}` }],
        actor: { id: actorId },
      })
      scenarios.push(scenario)
    }
    return { targetId, scenarios }
  }

  async function makeAccount(targetId: string, label: string, maxConcurrentSessions = 1): Promise<string> {
    const { targetAccounts } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targetAccounts).values({
      id,
      targetId,
      displayName: label,
      username: `u-${label}-${id.slice(0, 6)}`,
      status: 'active',
      maxConcurrentSessions,
    })
    return id
  }

  it('AC01: 模型校验与持久化（executionMode、maxConcurrency 默认值及上下限）', async () => {
    const { targetId, scenarios } = await seedTargetWithScenarios(2)
    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: 'AC01默认套件',
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            { memberId: 'm1', ordinal: 0, scenarioId: scenarios[0]!.id, scenarioVersionId: scenarios[0]!.published!.versionId, input: {} },
            { memberId: 'm2', ordinal: 1, scenarioId: scenarios[1]!.id, scenarioVersionId: scenarios[1]!.published!.versionId, input: {} },
          ],
        },
      },
      { kind: 'console', id: actorId },
    )
    expect(created.draft.document.executionMode).toBe('parallel')
    expect(created.draft.document.maxConcurrency).toBe(3)

    const published = await publishSuite(
      handle.db,
      created.id,
      { expectedRevision: created.draft.revision, idempotencyKey: `pub-ac01-${created.id}` },
      { kind: 'console', id: actorId },
    )
    expect(published.published?.document.executionMode).toBe('parallel')
    expect(published.published?.document.maxConcurrency).toBe(3)

    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-ac01-${created.id}` },
      { kind: 'console', id: actorId },
    )
    expect(observation.executionMode).toBe('parallel')
    expect(observation.maxConcurrency).toBe(3)
  })

  it('AC02: 多 Worker 并发认领（parallel 模式同时放行多个 ACTIVE，不同 Worker 成功并发认领不同 childRunId）', async () => {
    const { targetId, scenarios } = await seedTargetWithScenarios(3)
    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: 'AC02并发认领',
        document: {
          schemaVersion: 1,
          groups: [],
          members: scenarios.map((s, idx) => ({
            memberId: `m${idx + 1}`,
            ordinal: idx,
            scenarioId: s.id,
            scenarioVersionId: s.published!.versionId,
            input: {},
          })),
          executionMode: 'parallel',
          maxConcurrency: 3,
        },
      },
      { kind: 'console', id: actorId },
    )
    await publishSuite(handle.db, created.id, { expectedRevision: created.draft.revision, idempotencyKey: `pub-ac02-${created.id}` }, { kind: 'console', id: actorId })

    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-ac02-${created.id}` },
      { kind: 'console', id: actorId },
    )
    expect(observation.status).toBe('RUNNING')
    expect(observation.counts.active).toBe(3)
    expect(observation.counts.pending).toBe(0)
    expect(observation.items.every((it) => it.admission === 'ACTIVE')).toBe(true)

    // Register two distinct workers
    const w1Id = `w1-${newId()}`
    const w2Id = `w2-${newId()}`
    const inst1 = newId()
    const inst2 = newId()
    await registerWorker(handle.db, { workerId: w1Id, instanceId: inst1, capacity: 1, maxSessions: 1, lostAfterSeconds: 60, protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SUITE_ADMISSION_PROTOCOL] })
    await registerWorker(handle.db, { workerId: w2Id, instanceId: inst2, capacity: 1, maxSessions: 1, lostAfterSeconds: 60, protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SUITE_ADMISSION_PROTOCOL] })

    const claim1 = await claimRun(handle, { workerId: w1Id, instanceId: inst1, leaseTtlSeconds: 60 })
    const claim2 = await claimRun(handle, { workerId: w2Id, instanceId: inst2, leaseTtlSeconds: 60 })

    expect(claim1?.runId).toBeDefined()
    expect(claim2?.runId).toBeDefined()
    expect(claim1?.runId).not.toBe(claim2?.runId)
    const childRunIds = observation.items.map((it) => it.childRunId)
    expect(childRunIds).toContain(claim1?.runId)
    expect(childRunIds).toContain(claim2?.runId)
  })

  it('AC03: 串行模式回归（sequential 模式恒为单活，首项完成前第二项绝不处于 ACTIVE）', async () => {
    const { targetId, scenarios } = await seedTargetWithScenarios(2)
    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: 'AC03串行回归',
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            { memberId: 'm1', ordinal: 0, scenarioId: scenarios[0]!.id, scenarioVersionId: scenarios[0]!.published!.versionId, input: {} },
            { memberId: 'm2', ordinal: 1, scenarioId: scenarios[1]!.id, scenarioVersionId: scenarios[1]!.published!.versionId, input: {} },
          ],
          executionMode: 'sequential',
          maxConcurrency: 1,
        },
      },
      { kind: 'console', id: actorId },
    )
    await publishSuite(handle.db, created.id, { expectedRevision: created.draft.revision, idempotencyKey: `pub-ac03-${created.id}` }, { kind: 'console', id: actorId })

    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-ac03-${created.id}` },
      { kind: 'console', id: actorId },
    )
    expect(observation.counts.active).toBe(1)
    expect(observation.counts.pending).toBe(1)
    expect(observation.items[0]?.admission).toBe('ACTIVE')
    expect(observation.items[1]?.admission).toBe('PENDING')

    // Finish member 1
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', finishedAt: new Date(), updatedAt: new Date(), outcomeStatus: 'PASS' })
      .where(eq(runs.id, observation.items[0]!.childRunId))
    await scheduleSuiteAdvanceForChild(handle.db, observation.items[0]!.childRunId)

    const updated = await getSuiteRunObservation(handle.db, observation.id)
    expect(updated.items[0]?.admission).toBe('SETTLED')
    expect(updated.items[1]?.admission).toBe('ACTIVE')
    expect(updated.counts.active).toBe(1)
    expect(updated.counts.succeeded).toBe(1)
  })

  it('AC04: 独占账号防冲突（同 targetAccountId 且 exclusive 模式，即使 parallel 也串行等待释放）', async () => {
    const { targetId, scenarios } = await seedTargetWithScenarios(3)
    const accountA = await makeAccount(targetId, 'Account-A')
    const accountB = await makeAccount(targetId, 'Account-B')

    // m1 uses A, m2 uses A (same account!), m3 uses B (different account!)
    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: 'AC04账号冲突互斥',
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            { memberId: 'm1', ordinal: 0, scenarioId: scenarios[0]!.id, scenarioVersionId: scenarios[0]!.published!.versionId, targetAccountId: accountA, input: {} },
            { memberId: 'm2', ordinal: 1, scenarioId: scenarios[1]!.id, scenarioVersionId: scenarios[1]!.published!.versionId, targetAccountId: accountA, input: {} },
            { memberId: 'm3', ordinal: 2, scenarioId: scenarios[2]!.id, scenarioVersionId: scenarios[2]!.published!.versionId, targetAccountId: accountB, input: {} },
          ],
          executionMode: 'parallel',
          maxConcurrency: 3,
        },
      },
      { kind: 'console', id: actorId },
    )
    await publishSuite(handle.db, created.id, { expectedRevision: created.draft.revision, idempotencyKey: `pub-ac04-${created.id}` }, { kind: 'console', id: actorId })

    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-ac04-${created.id}` },
      { kind: 'console', id: actorId },
    )

    // m1 and m3 must be ACTIVE, m2 must be PENDING due to Account Mutex Guard!
    expect(observation.items[0]?.admission).toBe('ACTIVE')
    expect(observation.items[1]?.admission).toBe('PENDING')
    expect(observation.items[2]?.admission).toBe('ACTIVE')
    expect(observation.counts.active).toBe(2)
    expect(observation.counts.pending).toBe(1)

    // Finish m1
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', finishedAt: new Date(), updatedAt: new Date(), outcomeStatus: 'PASS' })
      .where(eq(runs.id, observation.items[0]!.childRunId))
    await scheduleSuiteAdvanceForChild(handle.db, observation.items[0]!.childRunId)

    // Now m2 can safely be admitted!
    const afterM1 = await getSuiteRunObservation(handle.db, observation.id)
    expect(afterM1.items[0]?.admission).toBe('SETTLED')
    expect(afterM1.items[1]?.admission).toBe('ACTIVE')
    expect(afterM1.items[2]?.admission).toBe('ACTIVE')
  })

  it('AC05: 异账号并发放行（不同 targetAccountId 时全速并发放行）', async () => {
    const { targetId, scenarios } = await seedTargetWithScenarios(2)
    const account1 = await makeAccount(targetId, 'Acc-1')
    const account2 = await makeAccount(targetId, 'Acc-2')

    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: 'AC05异账号并发',
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            { memberId: 'm1', ordinal: 0, scenarioId: scenarios[0]!.id, scenarioVersionId: scenarios[0]!.published!.versionId, targetAccountId: account1, input: {} },
            { memberId: 'm2', ordinal: 1, scenarioId: scenarios[1]!.id, scenarioVersionId: scenarios[1]!.published!.versionId, targetAccountId: account2, input: {} },
          ],
          executionMode: 'parallel',
          maxConcurrency: 2,
        },
      },
      { kind: 'console', id: actorId },
    )
    await publishSuite(handle.db, created.id, { expectedRevision: created.draft.revision, idempotencyKey: `pub-ac05-${created.id}` }, { kind: 'console', id: actorId })

    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-ac05-${created.id}` },
      { kind: 'console', id: actorId },
    )
    expect(observation.items[0]?.admission).toBe('ACTIVE')
    expect(observation.items[1]?.admission).toBe('ACTIVE')
    expect(observation.counts.active).toBe(2)
  })

  it('AC06: stop 策略故障熔断（在途成员取消，所有未开始成员标记 SKIPPED）', async () => {
    const { targetId, scenarios } = await seedTargetWithScenarios(3)
    const account1 = await makeAccount(targetId, 'Stop-1')
    const account2 = await makeAccount(targetId, 'Stop-2')
    const account3 = await makeAccount(targetId, 'Stop-3')

    // Concurrency limit 2, so m1 and m2 active, m3 pending
    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: 'AC06故障熔断',
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            { memberId: 'm1', ordinal: 0, scenarioId: scenarios[0]!.id, scenarioVersionId: scenarios[0]!.published!.versionId, targetAccountId: account1, input: {} },
            { memberId: 'm2', ordinal: 1, scenarioId: scenarios[1]!.id, scenarioVersionId: scenarios[1]!.published!.versionId, targetAccountId: account2, input: {} },
            { memberId: 'm3', ordinal: 2, scenarioId: scenarios[2]!.id, scenarioVersionId: scenarios[2]!.published!.versionId, targetAccountId: account3, input: {} },
          ],
          executionMode: 'parallel',
          maxConcurrency: 2,
          failurePolicy: 'stop',
        },
      },
      { kind: 'console', id: actorId },
    )
    await publishSuite(handle.db, created.id, { expectedRevision: created.draft.revision, idempotencyKey: `pub-ac06-${created.id}` }, { kind: 'console', id: actorId })

    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-ac06-${created.id}` },
      { kind: 'console', id: actorId },
    )
    expect(observation.items[0]?.admission).toBe('ACTIVE')
    expect(observation.items[1]?.admission).toBe('ACTIVE')
    expect(observation.items[2]?.admission).toBe('PENDING')

    // Member 1 fails!
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({ status: 'FAILED', finishedAt: new Date(), updatedAt: new Date(), outcomeStatus: 'FAIL' })
      .where(eq(runs.id, observation.items[0]!.childRunId))
    await advanceSuiteRun(handle.db, observation.id)

    const fused = await getSuiteRunObservation(handle.db, observation.id)
    expect(fused.items[0]?.admission).toBe('SETTLED')
    expect(fused.items[0]?.runStatus).toBe('FAILED')
    // Pending item m3 must be SKIPPED with reason failure_policy_stop
    expect(fused.items[2]?.admission).toBe('SKIPPED')
    expect(fused.items[2]?.skipReason).toBe('failure_policy_stop')
    // In-flight active member m2 should be cancelled
    expect(fused.items[1]?.runStatus).toBe('CANCELLED')
  })

  it('AC07: 计数恒等式（planned = succeeded + failed + cancelled + skipped + active + pending）', async () => {
    const { targetId, scenarios } = await seedTargetWithScenarios(3)
    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: 'AC07计数恒等式',
        document: {
          schemaVersion: 1,
          groups: [],
          members: scenarios.map((s, idx) => ({
            memberId: `m${idx + 1}`,
            ordinal: idx,
            scenarioId: s.id,
            scenarioVersionId: s.published!.versionId,
            input: {},
          })),
          executionMode: 'parallel',
          maxConcurrency: 2,
        },
      },
      { kind: 'console', id: actorId },
    )
    await publishSuite(handle.db, created.id, { expectedRevision: created.draft.revision, idempotencyKey: `pub-ac07-${created.id}` }, { kind: 'console', id: actorId })

    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-ac07-${created.id}` },
      { kind: 'console', id: actorId },
    )

    function checkConservation(obs: typeof observation) {
      const { planned, succeeded, failed, cancelled, skipped, active, pending } = obs.counts
      expect(planned).toBe(succeeded + failed + cancelled + skipped + active + pending)
    }

    checkConservation(observation)

    // Finish one, check again
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', finishedAt: new Date(), updatedAt: new Date(), outcomeStatus: 'PASS' })
      .where(eq(runs.id, observation.items[0]!.childRunId))
    const advanced = await advanceSuiteRun(handle.db, observation.id)
    checkConservation(advanced)
  })

  it('AC08: 耗时度量（wallClockMs 与 childDurationMs 并发度量）', async () => {
    const { targetId, scenarios } = await seedTargetWithScenarios(2)
    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: 'AC08耗时度量',
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            { memberId: 'm1', ordinal: 0, scenarioId: scenarios[0]!.id, scenarioVersionId: scenarios[0]!.published!.versionId, input: {} },
            { memberId: 'm2', ordinal: 1, scenarioId: scenarios[1]!.id, scenarioVersionId: scenarios[1]!.published!.versionId, input: {} },
          ],
          executionMode: 'parallel',
          maxConcurrency: 2,
        },
      },
      { kind: 'console', id: actorId },
    )
    await publishSuite(handle.db, created.id, { expectedRevision: created.draft.revision, idempotencyKey: `pub-ac08-${created.id}` }, { kind: 'console', id: actorId })

    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-ac08-${created.id}` },
      { kind: 'console', id: actorId },
    )

    const t0 = new Date(Date.now() - 5000)
    const t1 = new Date(Date.now() - 1000)
    const { runs } = schemaFor(handle.db)
    // Simulate both children ran in parallel for 4000ms each
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', startedAt: t0, finishedAt: t1, updatedAt: t1, outcomeStatus: 'PASS' })
      .where(eq(runs.id, observation.items[0]!.childRunId))
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', startedAt: t0, finishedAt: t1, updatedAt: t1, outcomeStatus: 'PASS' })
      .where(eq(runs.id, observation.items[1]!.childRunId))

    const finalized = await advanceSuiteRun(handle.db, observation.id)
    expect(finalized.status).toBe('COMPLETED')
    expect(finalized.childDurationMs).toBe(8000) // 4000 + 4000
    expect(finalized.wallClockMs).toBeGreaterThanOrEqual(0)
  })
})
