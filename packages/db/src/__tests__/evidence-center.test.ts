import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { Step } from '@cairn/shared'
import { OBJECT_MISSING_REASONS, objectKeyFor } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { authorizeTargetRequest } from '../console/target-authorization.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  deleteRun,
  getEvidence,
  listRetentionObjects,
  markStoredObjectPurged,
  searchEvidence,
  summarizeEvidenceRetention,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_evc`
const stepA: Step = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: '很长的中文步骤名称用于确认不串联',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'a' },
}
const stepB: Step = {
  id: '00000000-0000-4000-8000-0000000000b1',
  name: '回显乙',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'b' },
}

describe.each(DRIVERS)('%s 证据中心检索', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetAlpha: string
  let targetBeta: string
  let scenarioAlpha: string
  let scenarioBeta: string
  let failedThenOk: Awaited<ReturnType<typeof createRunWithSnapshot>>['detail']
  let otherTargetRun: Awaited<ReturnType<typeof createRunWithSnapshot>>['detail']
  let deletedRunId: string
  let historicalId: string
  let betaEvidenceId: string
  const stamp = new Date('2026-09-19T12:00:00.000Z')
  const queryAsOf = new Date('2026-09-19T12:00:10.000Z')

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    const { consoleAccounts, targets, evidences, attempts, runs, storedObjects } = schemaFor(handle.db)
    actorId = newId()
    targetAlpha = newId()
    targetBeta = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'evidence-center',
      email: `evc-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values([
      { id: targetAlpha, code: `eva-${SCHEMA.slice(-6)}`, name: '目标甲很长中文', entryUrl: 'https://a.example' },
      { id: targetBeta, code: `evb-${SCHEMA.slice(-6)}`, name: '目标乙', entryUrl: 'https://b.example' },
    ])
    const scA = await createScenarioWithVersion(handle.db, {
      targetId: targetAlpha,
      name: '场景甲',
      steps: [stepA],
      actor: { id: actorId },
    })
    const scB = await createScenarioWithVersion(handle.db, {
      targetId: targetBeta,
      name: '场景乙',
      steps: [stepB],
      actor: { id: actorId },
    })
    scenarioAlpha = scA.id
    scenarioBeta = scB.id
    const createdA = await createRunWithSnapshot(handle.db, { scenarioId: scenarioAlpha, actor: { id: actorId } })
    const createdB = await createRunWithSnapshot(handle.db, { scenarioId: scenarioBeta, actor: { id: actorId } })
    const createdDeleted = await createRunWithSnapshot(handle.db, { scenarioId: scenarioAlpha, actor: { id: actorId } })
    failedThenOk = createdA.detail
    otherTargetRun = createdB.detail
    deletedRunId = createdDeleted.detail.id

    const stepRunA = failedThenOk.stepRuns[0]!
    const failAttempt = newId()
    const okAttempt = newId()
    await handle.db.insert(attempts).values([
      {
        id: failAttempt,
        stepRunId: stepRunA.id,
        attemptNo: 1,
        status: 'FAILED',
        startedAt: stamp,
        finishedAt: stamp,
        error: { code: 'LOGIN_FAILED', safeMessage: '账号被锁' },
      },
      {
        id: okAttempt,
        stepRunId: stepRunA.id,
        attemptNo: 2,
        status: 'SUCCEEDED',
        startedAt: stamp,
        finishedAt: stamp,
        output: { ok: true },
      },
    ])
    await handle.db.update(schemaFor(handle.db).stepRuns).set({ status: 'SUCCEEDED' }).where(eq(schemaFor(handle.db).stepRuns.id, stepRunA.id))
    await handle.db.update(runs).set({ status: 'SUCCEEDED', evidenceStatus: 'COMPLETE' }).where(eq(runs.id, failedThenOk.id))

    const shotFail = newId()
    const shotOk = newId()
    const errEv = newId()
    historicalId = newId()
    await handle.db.insert(evidences).values([
      {
        id: shotFail,
        runId: failedThenOk.id,
        stepRunId: stepRunA.id,
        attemptId: failAttempt,
        type: 'screenshot',
        status: 'available',
        createdAt: stamp,
      },
      {
        id: errEv,
        runId: failedThenOk.id,
        stepRunId: stepRunA.id,
        attemptId: failAttempt,
        type: 'error',
        status: 'available',
        payload: { safeMessage: '账号被锁' },
        createdAt: new Date(stamp.getTime() + 1000),
      },
      {
        id: shotOk,
        runId: failedThenOk.id,
        stepRunId: stepRunA.id,
        attemptId: okAttempt,
        type: 'screenshot',
        status: 'available',
        createdAt: new Date(stamp.getTime() + 2000),
      },
      {
        id: historicalId,
        runId: failedThenOk.id,
        type: 'log',
        status: 'available',
        payload: { note: 'old' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ])

    const betaStep = otherTargetRun.stepRuns[0]!
    const betaAttempt = newId()
    betaEvidenceId = newId()
    await handle.db.insert(attempts).values({
      id: betaAttempt,
      stepRunId: betaStep.id,
      attemptNo: 1,
      status: 'FAILED',
      startedAt: stamp,
      finishedAt: stamp,
      error: { safeMessage: '乙失败' },
    })
    await handle.db.insert(evidences).values({
      id: betaEvidenceId,
      runId: otherTargetRun.id,
      stepRunId: betaStep.id,
      attemptId: betaAttempt,
      type: 'screenshot',
      status: 'missing',
      missingReason: OBJECT_MISSING_REASONS.captureFailed,
      createdAt: stamp,
    })
    await handle.db.update(runs).set({ status: 'FAILED', evidenceStatus: 'INCOMPLETE' }).where(eq(runs.id, otherTargetRun.id))

    const purgedObjectId = newId()
    await handle.db.insert(storedObjects).values({
      id: purgedObjectId,
      objectKey: objectKeyFor(failedThenOk.id, purgedObjectId),
      runId: failedThenOk.id,
      status: 'available',
      contentType: 'image/png',
      byteSize: 12,
      digest: `sha256:${'ab'.repeat(32)}`,
      retainUntil: new Date(stamp.getTime() + 3 * 24 * 60 * 60 * 1000),
      createdAt: stamp,
    })
    const expiredObjectId = newId()
    await handle.db.insert(storedObjects).values({
      id: expiredObjectId,
      objectKey: objectKeyFor(failedThenOk.id, expiredObjectId),
      runId: failedThenOk.id,
      status: 'available',
      contentType: 'image/png',
      byteSize: null,
      digest: `sha256:${'cd'.repeat(32)}`,
      retainUntil: new Date(stamp.getTime() - 60_000),
      createdAt: stamp,
    })
    await handle.db.insert(evidences).values({
      id: newId(),
      runId: failedThenOk.id,
      type: 'screenshot',
      status: 'available',
      objectId: purgedObjectId,
      objectKey: objectKeyFor(failedThenOk.id, purgedObjectId),
      createdAt: new Date(stamp.getTime() + 3000),
    })
    await markStoredObjectPurged(handle.db, {
      id: expiredObjectId,
      expectedStatus: 'available',
      reason: 'expired',
    })
    await handle.db.insert(evidences).values({
      id: newId(),
      runId: failedThenOk.id,
      type: 'trace',
      status: 'missing',
      missingReason: 'object_purged',
      objectId: expiredObjectId,
      objectKey: objectKeyFor(failedThenOk.id, expiredObjectId),
      createdAt: new Date(stamp.getTime() + 4000),
    })

    const unknownObj = newId()
    await handle.db.insert(storedObjects).values({
      id: unknownObj,
      objectKey: objectKeyFor(failedThenOk.id, unknownObj),
      runId: failedThenOk.id,
      status: 'available',
      contentType: 'image/png',
      byteSize: null,
      digest: `sha256:${'99'.repeat(32)}`,
      retainUntil: new Date(stamp.getTime() + 10 * 24 * 60 * 60 * 1000),
      createdAt: stamp,
    })

    const failObj = newId()
    await handle.db.insert(storedObjects).values({
      id: failObj,
      objectKey: objectKeyFor(otherTargetRun.id, failObj),
      runId: otherTargetRun.id,
      status: 'available',
      contentType: 'image/png',
      byteSize: 8,
      digest: `sha256:${'ef'.repeat(32)}`,
      retainUntil: stamp,
      purgeAttempts: 5,
      lastPurgeErrorAt: stamp,
      createdAt: stamp,
    })

    await handle.db.update(runs).set({ status: 'FAILED' }).where(eq(runs.id, deletedRunId))
    const deletedObj = newId()
    await handle.db.insert(storedObjects).values({
      id: deletedObj,
      objectKey: objectKeyFor(deletedRunId, deletedObj),
      runId: deletedRunId,
      status: 'available',
      contentType: 'image/png',
      byteSize: 4,
      digest: `sha256:${'11'.repeat(32)}`,
      retainUntil: stamp,
      createdAt: stamp,
    })
    await deleteRun(handle.db, deletedRunId, { id: actorId })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('ECA-02 结构化筛选与完整 ID 可越过默认时间窗；拒绝关键词', async () => {
    await expect(searchEvidence(handle.db, { q: '登录失败' } as never)).rejects.toMatchObject({
      code: 'INVALID_EVIDENCE_SEARCH',
    })
    const page = await searchEvidence(handle.db, {
      targetId: targetAlpha,
      types: ['screenshot'],
      asOf: queryAsOf.toISOString(),
    })
    expect(page.items.every((item) => item.targetId === targetAlpha)).toBe(true)
    expect(page.items.every((item) => item.evidence.type === 'screenshot')).toBe(true)
    const historical = await searchEvidence(handle.db, { evidenceId: historicalId, asOf: queryAsOf.toISOString() })
    expect(historical.timeWindowLifted).toBe(true)
    expect(historical.items[0]?.evidence.id).toBe(historicalId)
  })

  it('ECA-03 两个 Target 的证据不串联，步骤名来自冻结定义', async () => {
    const page = await searchEvidence(handle.db, {
      targetId: targetAlpha,
      asOf: queryAsOf.toISOString(),
      types: ['error'],
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.targetName).toBe('目标甲很长中文')
    expect(page.items[0]?.stepName).toBe('很长的中文步骤名称用于确认不串联')
    expect(page.items.some((item) => item.targetId === targetBeta)).toBe(false)
  })

  it('列表与详情的步骤名读 step_runs 投影，不回读 snapshot', async () => {
    const { stepRuns } = schemaFor(handle.db)
    const [projected] = await handle.db
      .select({ id: stepRuns.id, name: stepRuns.name })
      .from(stepRuns)
      .where(eq(stepRuns.runId, failedThenOk.id))
    expect(projected?.name).toBe('很长的中文步骤名称用于确认不串联')

    await handle.db.update(stepRuns).set({ name: '投影列展示名' }).where(eq(stepRuns.id, projected!.id))
    try {
      const page = await searchEvidence(handle.db, {
        targetId: targetAlpha,
        asOf: queryAsOf.toISOString(),
        types: ['error'],
      })
      expect(page.items[0]?.stepName).toBe('投影列展示名')
      const detail = await getEvidence(handle.db, page.items[0]!.evidence.id)
      expect(detail.item.stepName).toBe('投影列展示名')
    } finally {
      await handle.db
        .update(stepRuns)
        .set({ name: '很长的中文步骤名称用于确认不串联' })
        .where(eq(stepRuns.id, projected!.id))
    }
  })

  it('ECA-04 重试后成功保留失败与成功证据；预置视图命中正确', async () => {
    const failures = await searchEvidence(handle.db, {
      view: 'recent_failures',
      targetId: targetAlpha,
      asOf: queryAsOf.toISOString(),
    })
    expect(failures.items.some((item) => item.hitKind === 'attempt_failed')).toBe(true)
    expect(failures.items.some((item) => item.evidence.type === 'screenshot' && item.attemptStatus === 'SUCCEEDED')).toBe(
      false,
    )

    const retried = await searchEvidence(handle.db, {
      view: 'retried_success',
      runId: failedThenOk.id,
      asOf: queryAsOf.toISOString(),
    })
    const statuses = retried.items.map((item) => item.attemptStatus)
    expect(statuses).toEqual(expect.arrayContaining(['FAILED', 'SUCCEEDED']))
  })

  it('ECA-05 游标稳定且错配拒绝；asOf 之后的行不插入', async () => {
    const first = await searchEvidence(handle.db, { targetId: targetAlpha, asOf: queryAsOf.toISOString(), limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()
    const second = await searchEvidence(handle.db, {
      targetId: targetAlpha,
      asOf: queryAsOf.toISOString(),
      limit: 2,
      cursor: first.nextCursor,
    })
    const overlap = first.items.map((item) => item.evidence.id).filter((id) => second.items.some((item) => item.evidence.id === id))
    expect(overlap).toEqual([])
    await expect(
      searchEvidence(handle.db, {
        targetId: targetBeta,
        asOf: queryAsOf.toISOString(),
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })

    const { evidences } = schemaFor(handle.db)
    const lateId = newId()
    await handle.db.insert(evidences).values({
      id: lateId,
      runId: failedThenOk.id,
      type: 'log',
      status: 'available',
      createdAt: new Date(stamp.getTime() + 60_000),
    })
    const frozen = await searchEvidence(handle.db, { evidenceId: lateId, asOf: stamp.toISOString() })
    expect(frozen.items).toEqual([])
  })

  it('ECA-08 展示状态按投影归类', async () => {
    const capture = await searchEvidence(handle.db, {
      view: 'capture_upload_anomaly',
      asOf: queryAsOf.toISOString(),
    })
    expect(capture.items.some((item) => item.displayStatus === 'capture_upload_anomaly')).toBe(true)
    const purged = await searchEvidence(handle.db, {
      availability: ['purged'],
      asOf: queryAsOf.toISOString(),
    })
    expect(purged.items.some((item) => item.displayStatus === 'policy_purged')).toBe(true)
  })

  it('ECA-09 未知字节不按 0 汇总；清理失败对象可查', async () => {
    const summary = await summarizeEvidenceRetention(handle.db, {
      asOf: stamp,
      canListDeletedRunObjects: false,
    })
    expect(summary.accessible.unknownByteObjects).toBeGreaterThanOrEqual(1)
    expect(summary.deletedRunCleanup.objectCount).toBeGreaterThanOrEqual(1)
    const failed = await listRetentionObjects(
      handle.db,
      { view: 'purge_failed', asOf: stamp.toISOString(), limit: 20 },
      { canListDeletedRunObjects: false },
    )
    expect(failed.items.some((item) => item.candidateReason === 'purge_failed')).toBe(true)
  })

  it('ECA-10 已删除运行对 run:read 只聚合；逐项要 run:delete；内容不可读', async () => {
    const listed = await searchEvidence(handle.db, { runId: deletedRunId, asOf: queryAsOf.toISOString() })
    expect(listed.items).toEqual([])
    await expect(getEvidence(handle.db, historicalId)).resolves.toMatchObject({
      item: { evidence: { id: historicalId } },
    })
    await expect(
      listRetentionObjects(handle.db, { view: 'deleted_run', asOf: stamp.toISOString(), limit: 20 }, { canListDeletedRunObjects: false }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_DELETED_RUN_LIST_DENIED' })
    const items = await listRetentionObjects(
      handle.db,
      { view: 'deleted_run', asOf: stamp.toISOString(), limit: 20 },
      { canListDeletedRunObjects: true },
    )
    expect(items.items.some((item) => item.runId === deletedRunId && item.sourceIdVisible)).toBe(true)
  })

  it('selected 目标范围不能跨目标检索、读详情或看留存汇总', async () => {
    const { consoleAccounts, consoleRoles, consoleRolePermissions, consoleAccountRoles } = schemaFor(handle.db)
    const readerId = newId()
    const roleId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: readerId,
      displayName: 'evidence-scoped',
      email: `evs-${readerId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(consoleRoles).values({ id: roleId, key: `evs-${roleId}`, name: '局部证据只读' })
    await handle.db.insert(consoleRolePermissions).values(
      ['target:read', 'run:read'].map((permission) => ({ consoleRoleId: roleId, permission })),
    )
    await handle.db.insert(consoleAccountRoles).values({
      consoleAccountId: readerId,
      consoleRoleId: roleId,
      targetScopeMode: 'selected',
      targetScopeIds: [targetAlpha],
    })

    const unscoped = await searchEvidence(handle.db, { asOf: queryAsOf.toISOString() })
    expect(unscoped.items.some((item) => item.targetId === targetBeta)).toBe(true)

    const scoped = await searchEvidence(handle.db, { asOf: queryAsOf.toISOString() }, readerId)
    expect(scoped.items.length).toBeGreaterThan(0)
    expect(scoped.items.every((item) => item.targetId === targetAlpha)).toBe(true)
    expect(scoped.summary.evidenceCount).toBeLessThan(unscoped.summary.evidenceCount)

    await expect(getEvidence(handle.db, historicalId, readerId)).resolves.toMatchObject({
      item: { evidence: { id: historicalId }, targetId: targetAlpha },
    })
    await expect(getEvidence(handle.db, betaEvidenceId, readerId)).rejects.toMatchObject({
      code: 'EVIDENCE_NOT_FOUND',
    })
    await expect(
      authorizeTargetRequest(handle.db, readerId, { evidenceId: betaEvidenceId, permissions: ['run:read'] }),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(
      authorizeTargetRequest(handle.db, readerId, { evidenceId: historicalId, permissions: ['run:read'] }),
    ).resolves.toBeUndefined()

    const summary = await summarizeEvidenceRetention(handle.db, {
      asOf: stamp,
      actorId: readerId,
      canListDeletedRunObjects: false,
    })
    expect(summary.accessible.byTarget.map((row) => row.targetId)).toEqual([targetAlpha])
    expect(summary.accessible.byTarget.some((row) => row.targetName === '目标乙')).toBe(false)

    const failed = await listRetentionObjects(
      handle.db,
      { view: 'purge_failed', asOf: stamp.toISOString(), limit: 20 },
      { actorId: readerId, canListDeletedRunObjects: false },
    )
    expect(failed.items.every((item) => item.targetName !== '目标乙')).toBe(true)
  })
})

describe.each(DRIVERS)('%s 证据中心复查回归', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let runId: string
  let succeededRunId: string
  const stamp = new Date('2026-09-19T12:00:00.000Z')
  const asOf = new Date('2026-09-19T12:00:10.000Z')
  const stepOnly: Step = {
    id: '00000000-0000-4000-8000-0000000000c1',
    name: '回归步骤',
    type: 'echo',
    effectType: 'READ_ONLY',
    input: { value: 'c' },
  }

  beforeAll(async () => {
    handle = await openContractDb(driver, `${SCHEMA}-fix`)
    const { consoleAccounts, targets, runs, storedObjects, evidences } = schemaFor(handle.db)
    const actorId = newId()
    const targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'evidence-fixes',
      email: `evf-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `evf-${SCHEMA.slice(-6)}`,
      name: '回归目标',
      entryUrl: 'https://f.example',
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '回归场景',
      steps: [stepOnly],
      actor: { id: actorId },
    })
    const failedRun = await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } })
    const okRun = await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } })
    runId = failedRun.detail.id
    succeededRunId = okRun.detail.id
    await handle.db.update(runs).set({ status: 'FAILED', evidenceStatus: 'INCOMPLETE' }).where(eq(runs.id, runId))
    await handle.db.update(runs).set({ status: 'SUCCEEDED', evidenceStatus: 'COMPLETE' }).where(eq(runs.id, succeededRunId))

    const object = async (over: Record<string, unknown>) => {
      const id = newId()
      await handle.db.insert(storedObjects).values({
        id,
        objectKey: objectKeyFor(runId, id),
        runId,
        status: 'available',
        contentType: 'image/png',
        byteSize: 10,
        digest: `sha256:${'ab'.repeat(32)}`,
        retainUntil: new Date(stamp.getTime() + 30 * 86_400_000),
        createdAt: stamp,
        ...over,
      } as never)
      return id
    }
    // 占用：一个有效（10 字节）、一个已清理（1000 字节，不应计入）
    await object({})
    await object({
      status: 'purged',
      byteSize: 1000,
      purgedAt: stamp,
      purgeReason: 'expired',
      retainUntil: new Date(stamp.getTime() - 86_400_000),
    })
    // 刚上传中（2 秒前）与早已超过 pendingTtl 的 pending
    await object({ status: 'pending', byteSize: null, createdAt: new Date(asOf.getTime() - 2_000) })
    await object({ status: 'pending', byteSize: null, createdAt: new Date(asOf.getTime() - 7_200_000) })
    // 三个已到期、待清理的对象，用来翻页
    for (let i = 0; i < 3; i += 1) {
      await object({
        retainUntil: new Date(stamp.getTime() - 1_000 * (i + 1)),
        createdAt: new Date(stamp.getTime() + i * 1_000),
      })
    }

    // 成功运行的运行级录像：不是“运行失败”
    const videoObject = await object({ contentType: 'video/webm' })
    await handle.db.insert(evidences).values({
      id: newId(),
      runId: succeededRunId,
      type: 'video',
      status: 'available',
      objectId: videoObject,
      objectKey: objectKeyFor(runId, videoObject),
      createdAt: stamp,
    })
    // 失败运行的运行级错误证据、以及带 payload 的 input / log 证据
    await handle.db.insert(evidences).values([
      { id: newId(), runId, type: 'error', status: 'available', payload: { safeMessage: '运行失败原因' }, createdAt: stamp },
      { id: newId(), runId, type: 'input', status: 'available', payload: { account: 'somebody', note: '输入内容' }, createdAt: stamp },
    ])
    // 同一毫秒内、微秒不同的两行（PostgreSQL 微秒；MySQL DATETIME(3) 会落到同一毫秒并按 id 定序）
    if (driver === 'postgres') {
      await handle.db.execute(
        sql`insert into ${evidences} (id, run_id, type, status, created_at) values (${newId()}, ${runId}, 'log', 'available', '2026-09-19 12:00:05.123456+00'), (${newId()}, ${runId}, 'log', 'available', '2026-09-19 12:00:05.123789+00')`,
      )
    } else {
      await handle.db.insert(evidences).values([
        { id: newId(), runId, type: 'log', status: 'available', createdAt: new Date('2026-09-19T12:00:05.123Z') },
        { id: newId(), runId, type: 'log', status: 'available', createdAt: new Date('2026-09-19T12:00:05.123Z') },
      ])
    }
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('占用只统计未清理对象；待清理不含刚上传的 pending', async () => {
    const summary = await summarizeEvidenceRetention(handle.db, { asOf, canListDeletedRunObjects: false })
    // 有效：available×(1+3+1 视频) + pending×2；已清理的 1000 字节不计入
    expect(summary.accessible.objectCount).toBe(7)
    expect(summary.accessible.knownBytes).toBe(10 + 10 * 3 + 10)
    expect(summary.accessible.unknownByteObjects).toBe(2)
    // 待清理：3 个已到期 + 1 个超过 pendingTtl(3600s) 的 pending；刚上传的不算
    expect(summary.accessible.pendingCleanup.objectCount).toBe(4)
    expect(summary.accessible.byTarget).toHaveLength(1)
    expect(summary.accessible.byTarget[0]?.objectCount).toBe(7)
    const typed = Object.fromEntries(summary.accessible.byType.map((row) => [row.type, row.objectCount]))
    expect(typed.video).toBe(1)
    expect(typed.unlinked).toBe(6)
  })

  it('待清理清单与汇总同口径，并且上一页在第一页消失', async () => {
    const all = await listRetentionObjects(
      handle.db,
      { view: 'pending_cleanup', asOf: asOf.toISOString(), limit: 50 },
      { canListDeletedRunObjects: false },
    )
    expect(all.items).toHaveLength(4)
    expect(all.items.filter((item) => item.status === 'pending')).toHaveLength(1)

    const first = await listRetentionObjects(
      handle.db,
      { view: 'pending_cleanup', asOf: asOf.toISOString(), limit: 2 },
      { canListDeletedRunObjects: false },
    )
    expect(first.prevCursor).toBeUndefined()
    expect(first.nextCursor).toBeTruthy()
    const second = await listRetentionObjects(
      handle.db,
      { view: 'pending_cleanup', asOf: asOf.toISOString(), limit: 2, cursor: first.nextCursor },
      { canListDeletedRunObjects: false },
    )
    expect(second.prevCursor).toBeTruthy()
    const back = await listRetentionObjects(
      handle.db,
      { view: 'pending_cleanup', asOf: asOf.toISOString(), limit: 2, cursor: second.prevCursor },
      { canListDeletedRunObjects: false },
    )
    expect(back.items.map((item) => item.objectId)).toEqual(first.items.map((item) => item.objectId))
    expect(back.prevCursor).toBeUndefined()
    expect(back.nextCursor).toBeTruthy()
  })

  it('同一毫秒内不同微秒的证据翻页不丢行，也不重复', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const result = await searchEvidence(handle.db, {
        runId,
        types: ['log'],
        asOf: asOf.toISOString(),
        limit: 1,
        cursor,
      })
      seen.push(...result.items.map((item) => item.evidence.id))
      cursor = result.nextCursor
      if (!cursor) break
    }
    const whole = await searchEvidence(handle.db, { runId, types: ['log'], asOf: asOf.toISOString(), limit: 100 })
    expect(whole.items).toHaveLength(2)
    expect(seen).toEqual(whole.items.map((item) => item.evidence.id))
    expect(new Set(seen).size).toBe(2)
  })

  it('命中类型按事实标注：成功运行的录像不是运行失败', async () => {
    const video = await searchEvidence(handle.db, { runId: succeededRunId, types: ['video'], asOf: asOf.toISOString() })
    expect(video.items[0]?.runStatus).toBe('SUCCEEDED')
    expect(video.items[0]?.hitKind).toBeUndefined()
    const failed = await searchEvidence(handle.db, { runId, types: ['error'], asOf: asOf.toISOString() })
    expect(failed.items[0]?.hitKind).toBe('run_failed')
  })

  it('列表的错误摘要只来自错误证据，不把 input payload 当错误展示', async () => {
    const input = await searchEvidence(handle.db, { runId, types: ['input'], asOf: asOf.toISOString() })
    expect(input.items[0]?.errorSummary).toBeNull()
    const error = await searchEvidence(handle.db, { runId, types: ['error'], asOf: asOf.toISOString() })
    expect(error.items[0]?.errorSummary).toBe('运行失败原因')
  })

  it('游标内容被篡改时按 400 拒绝，而不是数据库报错', async () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 1, digest: 'x', sort: 'createdAt_desc', asOf: asOf.toISOString(), dir: 'next', k: 'not-a-date', id: 'not-a-uuid' }),
      'utf8',
    ).toString('base64url')
    await expect(
      searchEvidence(handle.db, { runId, asOf: asOf.toISOString(), cursor: forged }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  })
})
