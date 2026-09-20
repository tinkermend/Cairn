import { eq, ne } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_OCCUPANCY_PROTOCOL, SUITE_ADMISSION_PROTOCOL, type SuiteDocument } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { advanceDueSuiteRuns, advanceSuiteRun, cancelSuiteRun, claimRun, createScenarioWithVersion, createSuite, createSuiteRun, getSuiteRunObservation, previewSuiteRun, publishSuite, registerWorker, type NativeHandle } from '../test-entry.js'

describe.each(DRIVERS)('%s 集合取消、证据收敛与输入快照', (driver) => {
  let handle: NativeHandle, actorId: string
  const actor = () => ({ kind: 'console' as const, id: actorId })
  beforeAll(async () => {
    handle = await openContractDb(driver)
    const { consoleAccounts, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({ id: actorId, displayName: '集合验收', email: `${actorId}@example.com`, status: 'active' })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin!.id, targetScopeMode: 'all' })
  })
  afterAll(async () => { await handle?.close() })
  async function suite(inputRequired = false) {
    const { targets } = schemaFor(handle.db)
    const targetId = newId()
    await handle.db.insert(targets).values({ id: targetId, code: targetId, name: '集合系统', entryUrl: 'https://example.com' })
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: '集合成员', actor: actor(), inputs: inputRequired ? [{ key: 'shared', label: '共享输入' }] : [], steps: [
      { id: newId(), name: '检查输入', type: 'echo', effectType: 'READ_ONLY', input: inputRequired ? { from: 'shared' } : { value: 'ok' } },
    ] })
    const document: SuiteDocument = { schemaVersion: 1, groups: [], sharedInput: inputRequired ? { shared: '共享输入' } : {}, failurePolicy: 'continue', autoGenerateFinalReport: false,
      members: ['one', 'two'].map((memberId, ordinal) => ({ memberId, ordinal, scenarioId: scenario.id, scenarioVersionId: scenario.published!.versionId, input: {} })) }
    const made = await createSuite(handle.db, { targetId, name: '集合验收', document }, actor())
    await publishSuite(handle.db, made.id, { expectedRevision: made.draft.revision, idempotencyKey: newId() }, actor())
    return made.id
  }
  async function start(suiteId: string) { return (await createSuiteRun(handle.db, { suiteId, idempotencyKey: newId() }, actor())).observation }

  it('取消整集会取消 ACTIVE 子 Run，跳过 PENDING；核查中的未知副作用保持待核查', async () => {
    const observation = await start(await suite())
    const cancelled = await cancelSuiteRun(handle.db, observation.id, actor())
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.items[0]!.runStatus).toBe('CANCELLED')
    expect(cancelled.items[1]!.admission).toBe('SKIPPED')
    const review = await start(await suite())
    const { runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'NEEDS_REVIEW' }).where(eq(runs.id, review.items[0]!.childRunId))
    const blocked = await cancelSuiteRun(handle.db, review.id, actor())
    expect(blocked.status).toBe('NEEDS_REVIEW')
    expect(blocked.items[0]!.runStatus).toBe('NEEDS_REVIEW')
    expect(blocked.items[1]!.admission).toBe('SKIPPED')
  })

  it('已有执行租约时发出取消请求，不提前宣称执行已结束', async () => {
    const observation = await start(await suite())
    const childId = observation.items[0]!.childRunId
    const { runs } = schemaFor(handle.db)
    const excluded = await handle.db.select({ id: runs.id }).from(runs).where(ne(runs.id, childId))
    const worker = { workerId: `suite-${newId()}`, instanceId: newId() }
    await registerWorker(handle.db, { ...worker, capacity: 2, maxSessions: 2, lostAfterSeconds: 60, protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SUITE_ADMISSION_PROTOCOL] })
    const grant = await claimRun(handle, { ...worker, leaseTtlSeconds: 60, excludeRunIds: excluded.map((row) => row.id) })
    expect(grant?.runId).toBe(childId)
    await cancelSuiteRun(handle.db, observation.id, actor())
    const [child] = await handle.db.select().from(runs).where(eq(runs.id, childId))
    expect(child!.cancelRequestedAt).toBeTruthy()
    expect((await getSuiteRunObservation(handle.db, observation.id)).items[1]!.admission).toBe('SKIPPED')
  })

  it('截止时间会取消 ACTIVE 子 Run，终态证据延迟仍可收敛', async () => {
    const observation = await start(await suite())
    const { suiteRuns, runs } = schemaFor(handle.db)
    await handle.db.update(suiteRuns).set({ deadlineAt: new Date(Date.now() - 1000) }).where(eq(suiteRuns.id, observation.id))
    const cancelled = await advanceSuiteRun(handle.db, observation.id)
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.reason).toBe('deadline_elapsed')
    expect(cancelled.items[0]!.runStatus).toBe('CANCELLED')
    // Simulate evidence completing after the orchestration terminal transition.
    await handle.db.update(suiteRuns).set({ evidenceStatus: 'PENDING' }).where(eq(suiteRuns.id, observation.id))
    await handle.db.update(runs).set({ evidenceStatus: 'COMPLETE' }).where(eq(runs.suiteRunId, observation.id))
    await advanceDueSuiteRuns(handle.db, 100)
    expect((await getSuiteRunObservation(handle.db, observation.id)).evidenceStatus).toBe('COMPLETE')
  })

  it('共享输入与成员运行覆盖参与验证；并发同键只创建一套子 Run', async () => {
    const suiteId = await suite(true)
    const request = { suiteId, sharedInput: { shared: '本次共享值' }, memberOverrides: { two: { input: { shared: '成员覆盖' } } }, idempotencyKey: newId() }
    const preview = await previewSuiteRun(handle.db, request, actorId)
    expect(preview.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0)
    expect(preview.members[1]!.effectiveInput.shared).toBe('成员覆盖')
    const [one, two] = await Promise.all([createSuiteRun(handle.db, request, actor()), createSuiteRun(handle.db, request, actor())])
    expect(one.observation.id).toBe(two.observation.id)
    expect(one.observation.items.map((item) => item.childRunId)).toEqual(two.observation.items.map((item) => item.childRunId))
    const invalid = await previewSuiteRun(handle.db, { ...request, memberOverrides: { unknown: { input: {} } } }, actorId)
    expect(invalid.issues.some((issue) => issue.code === 'SUITE_MEMBER_NOT_FOUND')).toBe(true)
  })

  it('跨时钟的负耗时显示为未知，不阻断汇总和后续放行', async () => {
    const observation = await start(await suite())
    const { runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'SUCCEEDED', startedAt: new Date(), finishedAt: new Date(Date.now() - 1000) }).where(eq(runs.id, observation.items[0]!.childRunId))
    const advanced = await advanceSuiteRun(handle.db, observation.id)
    expect(advanced.childDurationMs).toBeNull()
    expect(advanced.items[1]!.admission).toBe('ACTIVE')
  })
})
