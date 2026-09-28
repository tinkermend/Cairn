import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  suiteDocumentSchema,
  type Step,
} from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  advanceSuiteRun,
  createScenarioWithVersion,
  createSuite,
  createSuiteRun,
  getSuiteRunObservation,
  publishSuite,
  rerunSuiteItem,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const echo: Step = {
  id: '00000000-0000-4000-8000-0000000000e1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'ok' },
}

describe.each(DRIVERS)('%s 场景集阶段编排与增量重跑', { timeout: 90_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `stage_suite_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'stage-tester',
      email: `stage-${actorId}@example.com`,
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

  async function seedTarget() {
    const { targets } = schemaFor(handle.db)
    const targetId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `stage-target-${targetId}`,
      name: '阶段巡检测试目标',
      entryUrl: 'https://shop.example/home',
    })
    const first = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '阶段一探活',
      steps: [echo],
      actor: { id: actorId },
    })
    const second = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '阶段二业务巡检',
      steps: [{ ...echo, id: '00000000-0000-4000-8000-0000000000e2' }],
      actor: { id: actorId },
    })
    return { targetId, first, second }
  }

  it('AC01 & AC02: Stage 阶段式顺序放行与跨阶段变量注入', async () => {
    const { targetId, first, second } = await seedTarget()

    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: '多阶段巡检集合',
        document: suiteDocumentSchema.parse({
          schemaVersion: 1,
          groups: [],
          stages: [
            {
              id: 'stage-login',
              name: '鉴权阶段',
              ordinal: 0,
              executionMode: 'parallel',
              maxConcurrency: 1,
              failurePolicy: 'stop',
              members: [
                {
                  memberId: 'm1',
                  ordinal: 0,
                  displayName: '用户登录',
                  scenarioId: first.id,
                  scenarioVersionId: first.published!.versionId,
                  input: {},
                },
              ],
            },
            {
              id: 'stage-business',
              name: '业务阶段',
              ordinal: 1,
              executionMode: 'parallel',
              maxConcurrency: 1,
              failurePolicy: 'continue',
              members: [
                {
                  memberId: 'm2',
                  ordinal: 0,
                  displayName: '查询订单',
                  scenarioId: second.id,
                  scenarioVersionId: second.published!.versionId,
                  input: {
                    userToken: '${stage[stage-login].members[m1].output.token}',
                    userId: '${stage[stage-login].members[m1].output.userId}',
                  },
                },
              ],
            },
          ],
          members: [],
        }),
      },
      { kind: 'console', id: actorId },
    )

    await publishSuite(
      handle.db,
      created.id,
      { expectedRevision: created.draft.revision, idempotencyKey: `pub-${created.id}` },
      { kind: 'console', id: actorId },
    )

    const { observation } = await createSuiteRun(
      handle.db,
      {
        suiteId: created.id,
        idempotencyKey: newId(),
      },
      { kind: 'console', id: actorId },
    )

    // Stage 0 is active, Stage 1 child run is lazy (childRunId is null)
    expect(observation.status).toBe('RUNNING')
    const item1 = observation.items.find((i) => i.memberId === 'm1')!
    const item2 = observation.items.find((i) => i.memberId === 'm2')!

    expect(item1.stageId).toBe('stage-login')
    expect(item1.stageOrdinal).toBe(0)
    expect(item1.admission).toBe('ACTIVE')
    expect(item1.childRunId).toBeTruthy()

    expect(item2.stageId).toBe('stage-business')
    expect(item2.stageOrdinal).toBe(1)
    expect(item2.admission).toBe('PENDING')
    expect(item2.childRunId).toBeNull()

    // Settle Stage 0 member with output containing variables for Stage 1
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        evidenceStatus: 'COMPLETE',
        finishedAt: new Date(),
        output: {
          summary: '登录成功',
          status: 'NORMAL',
          metrics: {},
          findings: [],
          dataRow: {
            token: 'jwt_mock_token_abcdef',
            userId: 12345,
          },
          assembledAt: new Date().toISOString(),
        },
      })
      .where(eq(runs.id, item1.childRunId!))

    // Advance suite run
    await advanceSuiteRun(handle.db, observation.id)

    // Now Stage 1 should be activated and lazy child run created with interpolated variables!
    const advancedObs = await getSuiteRunObservation(handle.db, observation.id)
    const item2Advanced = advancedObs.items.find((i) => i.memberId === 'm2')!

    expect(item2Advanced.admission).toBe('ACTIVE')
    expect(item2Advanced.childRunId).toBeTruthy()

    // Verify input in child run was interpolated!
    const [child2] = await handle.db.select().from(runs).where(eq(runs.id, item2Advanced.childRunId!))
    expect(child2?.snapshot.input).toEqual({
      userToken: 'jwt_mock_token_abcdef',
      userId: 12345,
    })
  })

  it('AC08: 阶段级失败策略 stop 阻断后续 Stage 执行', async () => {
    const { targetId, first, second } = await seedTarget()

    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: '阻断策略测试集合',
        document: suiteDocumentSchema.parse({
          schemaVersion: 1,
          groups: [],
          stages: [
            {
              id: 'stage-crit',
              name: '前置关键阶段',
              ordinal: 0,
              executionMode: 'parallel',
              maxConcurrency: 1,
              failurePolicy: 'stop',
              members: [
                {
                  memberId: 'm1',
                  ordinal: 0,
                  displayName: '前置检查',
                  scenarioId: first.id,
                  scenarioVersionId: first.published!.versionId,
                  input: {},
                },
              ],
            },
            {
              id: 'stage-sub',
              name: '后续阶段',
              ordinal: 1,
              executionMode: 'parallel',
              maxConcurrency: 1,
              failurePolicy: 'continue',
              members: [
                {
                  memberId: 'm2',
                  ordinal: 0,
                  displayName: '后续执行',
                  scenarioId: second.id,
                  scenarioVersionId: second.published!.versionId,
                  input: {},
                },
              ],
            },
          ],
          members: [],
        }),
      },
      { kind: 'console', id: actorId },
    )

    await publishSuite(
      handle.db,
      created.id,
      { expectedRevision: created.draft.revision, idempotencyKey: `pub-${created.id}` },
      { kind: 'console', id: actorId },
    )

    const { observation } = await createSuiteRun(
      handle.db,
      {
        suiteId: created.id,
        idempotencyKey: newId(),
      },
      { kind: 'console', id: actorId },
    )

    const item1 = observation.items.find((i) => i.memberId === 'm1')!

    // Mark stage 0 as failed
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({
        status: 'FAILED',
        outcomeStatus: 'FAIL',
        evidenceStatus: 'COMPLETE',
        finishedAt: new Date(),
      })
      .where(eq(runs.id, item1.childRunId!))

    await advanceSuiteRun(handle.db, observation.id)

    const finalObs = await getSuiteRunObservation(handle.db, observation.id)
    expect(finalObs.status).toBe('COMPLETED')
    expect(finalObs.verdict).toBe('anomalies_found')

    const item2 = finalObs.items.find((i) => i.memberId === 'm2')!
    expect(item2.admission).toBe('SKIPPED')
    expect(item2.skipReason).toBe('failure_policy_stop')
  })

  it('AC06 & AC07: 失败成员一键增量重跑与报告合流', async () => {
    const { targetId, first } = await seedTarget()

    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: '单成员重跑集合',
        document: suiteDocumentSchema.parse({
          schemaVersion: 1,
          groups: [],
          members: [
            {
              memberId: 'm1',
              ordinal: 0,
              displayName: '可能失败的成员',
              scenarioId: first.id,
              scenarioVersionId: first.published!.versionId,
              input: {},
            },
          ],
        }),
      },
      { kind: 'console', id: actorId },
    )

    await publishSuite(
      handle.db,
      created.id,
      { expectedRevision: created.draft.revision, idempotencyKey: `pub-${created.id}` },
      { kind: 'console', id: actorId },
    )

    const { observation } = await createSuiteRun(
      handle.db,
      {
        suiteId: created.id,
        idempotencyKey: newId(),
      },
      { kind: 'console', id: actorId },
    )

    const initialItem = observation.items.find((i) => i.memberId === 'm1')!
    const firstChildRunId = initialItem.childRunId!

    // Member fails
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({
        status: 'FAILED',
        outcomeStatus: 'FAIL',
        evidenceStatus: 'COMPLETE',
        finishedAt: new Date(),
      })
      .where(eq(runs.id, firstChildRunId))

    await advanceSuiteRun(handle.db, observation.id)

    const failedObs = await getSuiteRunObservation(handle.db, observation.id)
    expect(failedObs.status).toBe('COMPLETED')
    expect(failedObs.verdict).toBe('anomalies_found')

    // Now trigger rerun for member m1
    const rerunResult = await rerunSuiteItem(
      handle.db,
      {
        suiteRunId: observation.id,
        memberId: 'm1',
      },
      { kind: 'console', id: actorId },
    )

    expect(rerunResult.runId).not.toBe(firstChildRunId)
    const rerunItem = rerunResult.suiteRun.items.find((i) => i.memberId === 'm1')!
    expect(rerunItem.originalRunId).toBe(firstChildRunId)
    expect(rerunItem.rerunCount).toBe(1)
    expect(rerunResult.suiteRun.status).toBe('RUNNING')

    // Settle the rerun child run as SUCCEEDED
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        evidenceStatus: 'COMPLETE',
        finishedAt: new Date(),
        output: {
          summary: '重跑成功',
          status: 'NORMAL',
          metrics: {},
          findings: [],
          dataRow: { result: 'rerun_success' },
          assembledAt: new Date().toISOString(),
        },
      })
      .where(eq(runs.id, rerunResult.runId))

    await advanceSuiteRun(handle.db, observation.id)

    const finalObs = await getSuiteRunObservation(handle.db, observation.id)
    expect(finalObs.status).toBe('COMPLETED')
    expect(finalObs.verdict).toBe('all_pass')
  })
})
