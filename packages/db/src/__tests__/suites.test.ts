import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  listSuiteRuns,
  publishSuite,
  registerWorker,
  saveSuiteDraft,
  scheduleSuiteAdvanceForChild,
  searchEvidence,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const echo: Step = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'ok' },
}

describe.each(DRIVERS)('%s 场景集与放行', { timeout: 90_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `suite_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'suite',
      email: `suite-${actorId}@example.com`,
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
      code: `suite-${targetId}`,
      name: '集合夹具',
      entryUrl: 'https://shop.example/home',
    })
    const first = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '成员甲',
      steps: [echo],
      actor: { id: actorId },
    })
    const second = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '成员乙',
      steps: [{ ...echo, id: '00000000-0000-4000-8000-0000000000c2' }],
      actor: { id: actorId },
    })
    return { targetId, first, second }
  }

  it('发布、原子创建全部子 Run，并只放行第一项', async () => {
    const { targetId, first, second } = await seedTarget()
    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: '日常巡检',
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            {
              memberId: 'm1',
              ordinal: 0,
              scenarioId: first.id,
              scenarioVersionId: first.published!.versionId,
              displayName: '甲',
              input: {},
            },
            {
              memberId: 'm2',
              ordinal: 1,
              scenarioId: second.id,
              scenarioVersionId: second.published!.versionId,
              displayName: '乙',
              input: {},
            },
          ],
          sharedInput: {},
          failurePolicy: 'continue',
          autoGenerateFinalReport: false,
        },
      },
      { kind: 'console', id: actorId },
    )
    const published = await publishSuite(
      handle.db,
      created.id,
      { expectedRevision: created.draft.revision, idempotencyKey: `pub-${created.id}` },
      { kind: 'console', id: actorId },
    )
    expect(published.published?.versionNo).toBe(1)

    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-${created.id}` },
      { kind: 'console', id: actorId },
    )
    expect(observation.status).toBe('RUNNING')
    expect(observation.items).toHaveLength(2)
    expect(observation.items[0]?.admission).toBe('ACTIVE')
    expect(observation.items[1]?.admission).toBe('PENDING')
    expect(observation.items.every((item) => item.runStatus === 'QUEUED')).toBe(true)

    const workerId = `suite-w-${created.id.slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 2,
      maxSessions: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SUITE_ADMISSION_PROTOCOL],
    })

    const claimed = await claimRun(handle, { workerId, instanceId, leaseTtlSeconds: 60 })
    expect(claimed?.runId).toBe(observation.items[0]?.childRunId)

    const secondClaim = await claimRun(handle, { workerId, instanceId, leaseTtlSeconds: 60 })
    expect(secondClaim?.runId === observation.items[1]?.childRunId).toBe(false)
  })

  it('草稿 OCC 冲突不覆盖，开放服务不能创建集合运行', async () => {
    const { targetId, first } = await seedTarget()
    const created = await createSuite(handle.db, { targetId, name: 'OCC' }, { kind: 'console', id: actorId })
    await expect(
      saveSuiteDraft(
        handle.db,
        created.id,
        {
          expectedRevision: created.draft.revision + 1,
          document: {
            schemaVersion: 1,
            groups: [],
            members: [
              {
                memberId: 'm1',
                ordinal: 0,
                scenarioId: first.id,
                scenarioVersionId: first.published!.versionId,
                input: {},
              },
            ],
            sharedInput: {},
            failurePolicy: 'continue',
            autoGenerateFinalReport: false,
          },
        },
        { kind: 'console', id: actorId },
      ),
    ).rejects.toMatchObject({ code: 'SUITE_DRAFT_CONFLICT' })
    await expect(
      createSuiteRun(handle.db, { suiteId: created.id, idempotencyKey: 'svc-forbidden-key' }, {
        kind: 'service',
        id: newId(),
        credentialId: newId(),
        scopes: ['run:execute'],
      }),
    ).rejects.toMatchObject({ code: 'SUITE_SERVICE_FORBIDDEN' })
  })

  it.each(['FAILED', 'SUCCEEDED'] as const)('子 Run %s 且业务异常时 stop 策略跳过后续', async (status) => {
    const { targetId, first, second } = await seedTarget()
    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: '停止策略',
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            {
              memberId: 'm1',
              ordinal: 0,
              scenarioId: first.id,
              scenarioVersionId: first.published!.versionId,
              input: {},
            },
            {
              memberId: 'm2',
              ordinal: 1,
              scenarioId: second.id,
              scenarioVersionId: second.published!.versionId,
              input: {},
            },
          ],
          sharedInput: {},
          failurePolicy: 'stop',
          autoGenerateFinalReport: false,
        },
      },
      { kind: 'console', id: actorId },
    )
    await publishSuite(
      handle.db,
      created.id,
      { expectedRevision: created.draft.revision, idempotencyKey: `pub-stop-${created.id}` },
      { kind: 'console', id: actorId },
    )
    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-stop-${created.id}` },
      { kind: 'console', id: actorId },
    )
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({ status, finishedAt: new Date(), updatedAt: new Date(), outcomeStatus: 'FAIL' })
      .where(eq(runs.id, observation.items[0]!.childRunId))
    const advanced = await advanceSuiteRun(handle.db, observation.id)
    expect(advanced.items[0]?.admission).toBe('SETTLED')
    expect(advanced.items[1]?.admission).toBe('SKIPPED')
    expect(advanced.status).toBe('COMPLETED')
    expect(advanced.verdict).toBe('anomalies_found')
  })

  it('证据检索可按集合运行、成员和来源收口', async () => {
    const { targetId, first, second } = await seedTarget()
    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: '证据集合',
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            {
              memberId: 'm1',
              ordinal: 0,
              scenarioId: first.id,
              scenarioVersionId: first.published!.versionId,
              input: {},
            },
            {
              memberId: 'm2',
              ordinal: 1,
              scenarioId: second.id,
              scenarioVersionId: second.published!.versionId,
              input: {},
            },
          ],
          sharedInput: {},
          failurePolicy: 'continue',
          autoGenerateFinalReport: false,
        },
      },
      { kind: 'console', id: actorId },
    )
    await publishSuite(
      handle.db,
      created.id,
      { expectedRevision: created.draft.revision, idempotencyKey: `pub-ev-${created.id}` },
      { kind: 'console', id: actorId },
    )
    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-ev-${created.id}` },
      { kind: 'console', id: actorId },
    )
    const { evidences } = schemaFor(handle.db)
    const evidenceId = newId()
    const createdAt = new Date('2026-09-19T12:00:00.000Z')
    await handle.db.insert(evidences).values({
      id: evidenceId,
      runId: observation.items[0]!.childRunId,
      type: 'log',
      status: 'available',
      payload: { note: 'suite' },
      createdAt,
    })
    const asOf = '2026-09-19T12:00:10.000Z'
    const bySuiteRun = await searchEvidence(handle.db, { suiteRunId: observation.id, asOf })
    expect(bySuiteRun.items.some((item) => item.evidence.id === evidenceId)).toBe(true)
    const byMember = await searchEvidence(handle.db, { suiteRunId: observation.id, memberId: 'm1', asOf })
    expect(byMember.items.some((item) => item.evidence.id === evidenceId)).toBe(true)
    const otherMember = await searchEvidence(handle.db, { suiteRunId: observation.id, memberId: 'm2', asOf })
    expect(otherMember.items.some((item) => item.evidence.id === evidenceId)).toBe(false)
    const byOrigin = await searchEvidence(handle.db, {
      suiteRunId: observation.id,
      executionOrigin: 'suite_member',
      asOf,
    })
    expect(byOrigin.items.some((item) => item.evidence.id === evidenceId)).toBe(true)
    const standalone = await searchEvidence(handle.db, {
      suiteRunId: observation.id,
      executionOrigin: 'standalone',
      asOf,
    })
    expect(standalone.items.some((item) => item.evidence.id === evidenceId)).toBe(false)
  })

  it('列表给出 ISO 时间；子 Run 成功后自动放行下一项', async () => {
    const { targetId, first, second } = await seedTarget()
    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: '自动推进',
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            {
              memberId: 'm1',
              ordinal: 0,
              scenarioId: first.id,
              scenarioVersionId: first.published!.versionId,
              displayName: '甲',
              input: {},
            },
            {
              memberId: 'm2',
              ordinal: 1,
              scenarioId: second.id,
              scenarioVersionId: second.published!.versionId,
              displayName: '乙',
              input: {},
            },
          ],
          sharedInput: {},
          failurePolicy: 'continue',
          autoGenerateFinalReport: false,
        },
      },
      { kind: 'console', id: actorId },
    )
    await publishSuite(
      handle.db,
      created.id,
      { expectedRevision: created.draft.revision, idempotencyKey: `pub-adv-${created.id}` },
      { kind: 'console', id: actorId },
    )
    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: created.id, idempotencyKey: `run-adv-${created.id}` },
      { kind: 'console', id: actorId },
    )
    const listed = await listSuiteRuns(handle.db, { suiteId: created.id }, actorId)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(listed.items[0]?.suiteName).toBe('自动推进')
    expect(listed.items[0]?.counts.active).toBe(1)

    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', finishedAt: new Date(), updatedAt: new Date(), outcomeStatus: 'PASS' })
      .where(eq(runs.id, observation.items[0]!.childRunId))
    await scheduleSuiteAdvanceForChild(handle.db, observation.items[0]!.childRunId)
    const advanced = await getSuiteRunObservation(handle.db, observation.id)
    expect(advanced.items[0]?.admission).toBe('SETTLED')
    expect(advanced.items[1]?.admission).toBe('ACTIVE')
    expect(advanced.status).toBe('RUNNING')
  })
})
