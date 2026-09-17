import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor, databaseNow, afterSeconds } from '../native.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  EVIDENCE_INCOMPLETE_CODE,
  OBJECT_MISSING_REASONS,
  REDACTED,
  type Step,
} from '@cairn/shared'
import {
  claimSessionUse,
  commitObjectEvidence,
  commitStoredObject,
  createRunWithSnapshot,
  createScenarioWithVersion,
  deleteRun,
  finishAttempt,
  getRun,
  isolateOrphanedSessions,
  listPurgeCandidates,
  listRunEvidence,
  markOrphanedRunVideoLost,
  markStoredObjectPurged,
  openIsolatedDb,
  requireCreatedSession,
  reserveObjectEvidence,
  settleRunEvidence,
  settleExpiredPendingEvidence,
  settleFinishedPendingRuns,
  setSessionStatus,
  startAttempt,
  reviewRun,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
let consoleAccounts = pg_consoleAccounts
import { runs as pg_runs, stepRuns as pg_stepRuns } from '../schema/execution.js'
let runs = pg_runs
let stepRuns = pg_stepRuns
import { storedObjects as pg_storedObjects } from '../schema/objects.js'
let storedObjects = pg_storedObjects
import { targets as pg_targets } from '../schema/targets.js'
let targets = pg_targets
import { forceGrantForRun, seedWorker } from './lease-harness.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_evs`

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'greeting',
  input: { value: 'hello-secret' },
}

const navigateStep: Step = {
  id: '00000000-0000-4000-8000-0000000000b1',
  name: '打开',
  type: 'navigate',
  effectType: 'READ_ONLY',
  input: { url: 'https://shop.example/orders' },
}

describe.each(DRIVERS)('%s 证据轴与收尾（集成）', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let scenarioId: string
  let browserScenarioId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    ;({ consoleAccounts, runs, stepRuns, storedObjects, targets } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'ev-tester',
      email: `ev-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `evs-${SCHEMA.slice(-6)}`,
      name: '证据夹具',
      entryUrl: 'https://example.com',
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '证据轴',
      steps: [echoStep],
      actor: { id: actorId },
    })
    scenarioId = scenario.id
    browserScenarioId = (
      await createScenarioWithVersion(handle.db, {
        targetId,
        name: '浏览器证据轴',
        steps: [navigateStep],
        actor: { id: actorId },
      })
    ).id
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function succeedEcho(input: {
    evidencePolicy?: { screenshot?: 'always' | 'off'; required?: Array<'input' | 'screenshot'> }
    secrets?: string[]
    extraInput?: Record<string, string>
  }) {
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId,
      input: input.extraInput,
      evidencePolicy: input.evidencePolicy,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const detail = created.detail
    const [step] = await handle.db.select().from(stepRuns).where(eq(stepRuns.runId, detail.id))
    const started = await startAttempt(handle.db, {
      runId: detail.id,
      stepRunId: step!.id,
      inputPayload: { value: 'hello-secret' },
      grant,
      secrets: input.secrets,
    })
    expect(started).toBeTruthy()
    await finishAttempt(handle.db, {
      runId: detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { echoed: 'hello-secret', tokenCount: 3 },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
      secrets: input.secrets,
    })
    return { runId: detail.id, attemptId: started!.attemptId, grant }
  }

  it('两根轴分开：必要截图缺失时 SUCCEEDED + INCOMPLETE', async () => {
    const { runId } = await succeedEcho({
      evidencePolicy: { screenshot: 'always', required: ['input', 'screenshot'] },
    })
    const settled = await settleRunEvidence(handle.db, runId, {
      pendingTtlSeconds: 3600,
      maxUploadAttempts: 3,
    })
    expect(settled.evidenceStatus).toBe('INCOMPLETE')
    const [run] = await handle.db.select().from(runs).where(eq(runs.id, runId))
    expect(run?.status).toBe('SUCCEEDED')
    expect(run?.evidenceStatus).toBe('INCOMPLETE')
    const listed = await listRunEvidence(handle.db, runId)
    expect(listed.items.some((item) => item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload) && item.payload.code === EVIDENCE_INCOMPLETE_CODE)).toBe(true)
    const detail = await getRun(handle.db, runId)
    expect(detail.stepRuns[0]?.attempts[0]?.status).toBe('SUCCEEDED')
  })

  it('债务可重试：同一 pending 行 commit 后 available，对象只有一份', async () => {
    const { runId, attemptId } = await succeedEcho({})
    const reserved = await reserveObjectEvidence(handle.db, {
      runId,
      attemptId,
      type: 'screenshot',
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    expect(reserved.status).toBe('pending')
    expect(reserved.objectKey).toBeTruthy()
    await commitStoredObject(handle.db, {
      id: reserved.objectKey!.split('/').at(-1)!,
      contentType: 'image/png',
      byteSize: 4,
      digest: `sha256:${'ab'.repeat(32)}`,
    })
    const committed = await commitObjectEvidence(handle.db, {
      id: reserved.id,
      contentType: 'image/png',
      byteSize: 4,
      digest: `sha256:${'ab'.repeat(32)}`,
    })
    expect(committed?.status).toBe('available')
    const objects = await handle.db.select().from(storedObjects).where(eq(storedObjects.runId, runId))
    expect(objects.filter((row) => row.objectKey === reserved.objectKey)).toHaveLength(1)
  })

  it('崩溃只补账：过期 pending 收尾写成 worker_lost，不碰执行状态与 updated_at', async () => {
    const { runId, attemptId } = await succeedEcho({
      evidencePolicy: { required: ['input', 'screenshot'] },
    })
    const reserved = await reserveObjectEvidence(handle.db, {
      runId,
      attemptId,
      type: 'screenshot',
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    const past = new Date(Date.now() - 10_000)
    await handle.db
      .update(storedObjects)
      .set({ createdAt: past })
      .where(eq(storedObjects.objectKey, reserved.objectKey!))
    const [before] = await handle.db.select().from(runs).where(eq(runs.id, runId))
    const first = await settleExpiredPendingEvidence(handle.db, {
      pendingTtlSeconds: 1,
      maxUploadAttempts: 3,
    })
    expect(first.marked).toBeGreaterThanOrEqual(1)
    const listed = await listRunEvidence(handle.db, runId)
    const shot = listed.items.find((item) => item.id === reserved.id)
    expect(shot?.status).toBe('missing')
    expect(shot?.missingReason).toBe(OBJECT_MISSING_REASONS.workerLost)
    const [after] = await handle.db.select().from(runs).where(eq(runs.id, runId))
    expect(after?.status).toBe('SUCCEEDED')
    expect(after?.updatedAt.getTime()).toBe(before!.updatedAt.getTime())
    expect(after?.evidenceStatus).toBe('INCOMPLETE')

    await settleExpiredPendingEvidence(handle.db, {
      pendingTtlSeconds: 1,
      maxUploadAttempts: 3,
    })
    const incomplete = listed.items.filter(
      (item) =>
        item.type === 'error' &&
        item.payload &&
        typeof item.payload === 'object' &&
        !Array.isArray(item.payload) &&
        item.payload.code === EVIDENCE_INCOMPLETE_CODE,
    )
    const afterListed = await listRunEvidence(handle.db, runId)
    expect(
      afterListed.items.filter(
        (item) =>
          item.type === 'error' &&
          item.payload &&
          typeof item.payload === 'object' &&
          !Array.isArray(item.payload) &&
          item.payload.code === EVIDENCE_INCOMPLETE_CODE,
      ),
    ).toHaveLength(1)
    expect(incomplete.length).toBeLessThanOrEqual(1)
  })

  it('过期清理不翻转已定死的 COMPLETE，且同步写 status=missing', async () => {
    const { runId, attemptId } = await succeedEcho({})
    await settleRunEvidence(handle.db, runId, { pendingTtlSeconds: 3600, maxUploadAttempts: 3 })
    const reserved = await reserveObjectEvidence(handle.db, {
      runId,
      attemptId,
      type: 'log',
      retainUntil: new Date(Date.now() - 1000),
    })
    await commitStoredObject(handle.db, {
      id: reserved.objectKey!.split('/').at(-1)!,
      contentType: 'text/plain',
      byteSize: 2,
      digest: `sha256:${'cd'.repeat(32)}`,
    })
    await commitObjectEvidence(handle.db, {
      id: reserved.id,
      contentType: 'text/plain',
      byteSize: 2,
      digest: `sha256:${'cd'.repeat(32)}`,
    })
    await settleRunEvidence(handle.db, runId, { pendingTtlSeconds: 3600, maxUploadAttempts: 3 })
    await handle.db
      .update(storedObjects)
      .set({ retainUntil: new Date(Date.now() - 1000) })
      .where(eq(storedObjects.objectKey, reserved.objectKey!))
    const purged = await markStoredObjectPurged(handle.db, {
      id: reserved.objectKey!.split('/').at(-1)!,
      expectedStatus: 'available',
      reason: 'expired',
    })
    expect(purged.updated).toBe(true)
    const listed = await listRunEvidence(handle.db, runId)
    const row = listed.items.find((item) => item.id === reserved.id)
    expect(row?.status).toBe('missing')
    expect(row?.missingReason).toBe(OBJECT_MISSING_REASONS.purged)
    const [run] = await handle.db.select().from(runs).where(eq(runs.id, runId))
    expect(run?.evidenceStatus).toBe('COMPLETE')
  })

  it('脱敏在写入前生效，tokenCount 不被误伤', async () => {
    const { runId } = await succeedEcho({ secrets: ['hello-secret'] })
    const listed = await listRunEvidence(handle.db, runId)
    const dumped = JSON.stringify(listed.items.map((item) => item.payload))
    expect(dumped).not.toContain('hello-secret')
    expect(dumped).toContain(REDACTED)
    expect(dumped).toContain('tokenCount')
    expect(dumped).toContain('3')
  })

  it('对象已 available、证据仍 pending：收尾只 commit，不标 worker_lost', async () => {
    const { runId, attemptId } = await succeedEcho({
      evidencePolicy: { required: ['input', 'screenshot'] },
    })
    const reserved = await reserveObjectEvidence(handle.db, {
      runId,
      attemptId,
      type: 'screenshot',
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    await commitStoredObject(handle.db, {
      id: reserved.objectKey!.split('/').at(-1)!,
      contentType: 'image/png',
      byteSize: 4,
      digest: `sha256:${'ab'.repeat(32)}`,
    })
    const [before] = await handle.db.select().from(runs).where(eq(runs.id, runId))
    expect(before?.evidenceStatus).toBe('PENDING')
    const settled = await settleExpiredPendingEvidence(handle.db, {
      pendingTtlSeconds: 3600,
      maxUploadAttempts: 3,
    })
    expect(settled.committed).toBeGreaterThanOrEqual(1)
    const listed = await listRunEvidence(handle.db, runId)
    const shot = listed.items.find((item) => item.id === reserved.id)
    expect(shot?.status).toBe('available')
    expect(shot?.missingReason).toBeUndefined()
    const [after] = await handle.db.select().from(runs).where(eq(runs.id, runId))
    expect(after?.status).toBe('SUCCEEDED')
    expect(after?.updatedAt.getTime()).toBe(before!.updatedAt.getTime())
    expect(after?.evidenceStatus).toBe('COMPLETE')
  })

  it('已终态且轴仍 PENDING、无 pending 行时扫描迁出', async () => {
    const { runId } = await succeedEcho({})
    const [before] = await handle.db.select().from(runs).where(eq(runs.id, runId))
    expect(before?.status).toBe('SUCCEEDED')
    expect(before?.evidenceStatus).toBe('PENDING')
    const scanned = await settleFinishedPendingRuns(handle.db, {
      pendingTtlSeconds: 3600,
      maxUploadAttempts: 3,
    })
    expect(scanned.settled).toBeGreaterThanOrEqual(1)
    const [after] = await handle.db.select().from(runs).where(eq(runs.id, runId))
    expect(after?.evidenceStatus).toBe('COMPLETE')
    expect(after?.status).toBe('SUCCEEDED')
    expect(after?.updatedAt.getTime()).toBe(before!.updatedAt.getTime())
  })

  it('reviewRun 给出结论后同一请求内轴迁出 PENDING', async () => {
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const [step] = await handle.db.select().from(stepRuns).where(eq(stepRuns.runId, created.detail.id))
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: step!.id,
      inputPayload: { value: 'hello-secret' },
      grant,
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'FAILED',
      error: {
        code: 'TIMEOUT',
        category: 'TIMEOUT',
        retryable: false,
        safeMessage: '副作用未确认',
      },
      stepRunStatus: 'FAILED',
      runStatus: 'NEEDS_REVIEW',
      grant,
    })
    const [halted] = await handle.db.select().from(runs).where(eq(runs.id, created.detail.id))
    expect(halted?.status).toBe('NEEDS_REVIEW')
    expect(halted?.evidenceStatus).toBe('PENDING')
    await reviewRun(handle.db, { runId: created.detail.id, actor: { id: actorId }, conclusion: 'fail' })
    const [concluded] = await handle.db.select().from(runs).where(eq(runs.id, created.detail.id))
    expect(concluded?.status).toBe('FAILED')
    expect(concluded?.evidenceStatus).toBe('COMPLETE')
  })

  async function finishBrowserAttempt(input: {
    evidencePolicy?: {
      screenshot?: 'always' | 'off' | 'on_failure'
      video?: 'always' | 'off'
      required?: Array<'input' | 'screenshot'>
    }
    attemptStatus?: 'SUCCEEDED' | 'FAILED'
    runStatus?: 'SUCCEEDED' | 'FAILED'
  }) {
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: browserScenarioId,
      evidencePolicy: input.evidencePolicy,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const [step] = await handle.db.select().from(stepRuns).where(eq(stepRuns.runId, created.detail.id))
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: step!.id,
      inputPayload: { url: 'https://shop.example/orders' },
      grant,
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: input.attemptStatus ?? 'SUCCEEDED',
      output: { ok: true },
      ...(input.attemptStatus === 'FAILED'
        ? {
            error: { code: 'TIMEOUT', category: 'TIMEOUT', retryable: false, safeMessage: '打开失败' },
          }
        : {}),
      stepRunStatus: input.attemptStatus ?? 'SUCCEEDED',
      runStatus: input.runStatus ?? 'SUCCEEDED',
      grant,
    })
    return { runId: created.detail.id, attemptId: started!.attemptId }
  }

  it('纯 Echo 即使出厂录像 always 也不建 video 槽', async () => {
    const { runId } = await succeedEcho({})
    const settled = await settleRunEvidence(handle.db, runId, {
      pendingTtlSeconds: 3600,
      maxUploadAttempts: 3,
    })
    expect(settled.evidenceStatus).toBe('COMPLETE')
    const listed = await listRunEvidence(handle.db, runId)
    expect(listed.items.some((item) => item.type === 'video')).toBe(false)
  })

  it('步骤开始前失败：有浏览器步骤也不欠 video', async () => {
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: browserScenarioId,
      evidencePolicy: { video: 'always', screenshot: 'off' },
      actor: { id: actorId },
    })
    await handle.db
      .update(runs)
      .set({ status: 'FAILED', finishedAt: new Date() })
      .where(eq(runs.id, created.detail.id))
    const settled = await settleRunEvidence(handle.db, created.detail.id, {
      pendingTtlSeconds: 3600,
      maxUploadAttempts: 3,
    })
    expect(settled.evidenceStatus).toBe('COMPLETE')
    const listed = await listRunEvidence(handle.db, created.detail.id)
    expect(listed.items.some((item) => item.type === 'video')).toBe(false)
  })

  it('浏览器 Attempt 已结束且尚未 reserve 视频：证据轴 INCOMPLETE', async () => {
    const { runId } = await finishBrowserAttempt({
      evidencePolicy: { screenshot: 'off', video: 'always' },
    })
    const settled = await settleRunEvidence(handle.db, runId, {
      pendingTtlSeconds: 3600,
      maxUploadAttempts: 3,
    })
    expect(settled.evidenceStatus).toBe('INCOMPLETE')
    const [run] = await handle.db.select().from(runs).where(eq(runs.id, runId))
    expect(run?.status).toBe('SUCCEEDED')
    const listed = await listRunEvidence(handle.db, runId)
    const incomplete = listed.items.find(
      (item) =>
        item.type === 'error' &&
        item.payload &&
        typeof item.payload === 'object' &&
        !Array.isArray(item.payload) &&
        item.payload.code === EVIDENCE_INCOMPLETE_CODE,
    )
    expect(incomplete).toBeTruthy()
    expect(JSON.stringify(incomplete?.payload)).toContain('video')
  })

  it('旧 Snapshot 无 video 字段：成功浏览器步不欠录像', async () => {
    const { runId } = await finishBrowserAttempt({
      evidencePolicy: { screenshot: 'on_failure', video: 'off' },
    })
    const [row] = await handle.db.select().from(runs).where(eq(runs.id, runId))
    const snapshot = { ...(row!.snapshot as Record<string, unknown>), evidencePolicy: { screenshot: 'on_failure' } }
    // Snapshot 列有不可变触发器，历史形态只能用测试管理 SQL 写入，不能走业务 UPDATE。
    if (driver === 'postgres') {
      await handle.raw('ALTER TABLE cairn.runs DISABLE TRIGGER runs_snapshot_immutable')
      try {
        await handle.raw('UPDATE cairn.runs SET snapshot = $1::jsonb WHERE id = $2::uuid', [
          JSON.stringify(snapshot),
          runId,
        ])
      } finally {
        await handle.raw('ALTER TABLE cairn.runs ENABLE TRIGGER runs_snapshot_immutable')
      }
    } else {
      await handle.raw('UPDATE runs SET snapshot = CAST(? AS JSON) WHERE id = ?', [
        JSON.stringify(snapshot),
        runId,
      ])
    }
    const settled = await settleRunEvidence(handle.db, runId, {
      pendingTtlSeconds: 3600,
      maxUploadAttempts: 3,
    })
    expect(settled.evidenceStatus).toBe('COMPLETE')
    const listed = await listRunEvidence(handle.db, runId)
    expect(listed.items.some((item) => item.type === 'video')).toBe(false)
  })

  it('重复 reserve 运行级 video 回同一行', async () => {
    const { runId } = await finishBrowserAttempt({
      evidencePolicy: { screenshot: 'off', video: 'always' },
    })
    const first = await reserveObjectEvidence(handle.db, {
      runId,
      type: 'video',
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    const second = await reserveObjectEvidence(handle.db, {
      runId,
      type: 'video',
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    expect(second.id).toBe(first.id)
    expect(second.objectKey).toBe(first.objectKey)
    await commitStoredObject(handle.db, {
      id: first.objectKey!.split('/').at(-1)!,
      contentType: 'video/webm',
      byteSize: 8,
      digest: `sha256:${'ef'.repeat(32)}`,
    })
    await commitObjectEvidence(handle.db, {
      id: first.id,
      contentType: 'video/webm',
      byteSize: 8,
      digest: `sha256:${'ef'.repeat(32)}`,
    })
    const settled = await settleRunEvidence(handle.db, runId, {
      pendingTtlSeconds: 3600,
      maxUploadAttempts: 3,
    })
    expect(settled.evidenceStatus).toBe('COMPLETE')
    const listed = await listRunEvidence(handle.db, runId)
    expect(listed.items.filter((item) => item.type === 'video' && !item.attemptId)).toHaveLength(1)
  })

  it('进程换代后 pending 录像立刻记 worker_lost，不等 pending TTL', async () => {
    const { targetAccounts, workers } = schemaFor(handle.db)
    const accountId = newId()
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '录像账号',
      username: `video-${accountId.slice(0, 8)}`,
      status: 'active',
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: browserScenarioId,
      targetAccountId: accountId,
      evidencePolicy: { screenshot: 'off', video: 'always' },
      actor: { id: actorId },
    })
    const runId = created.detail.id
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, runId, worker.workerId)
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(
      await setSessionStatus(handle.db, {
        sessionId: session.id,
        expectedVersion: session.version,
        status: 'OPEN',
        ownerWorkerId: worker.workerId,
        ownerWorkerInstanceId: worker.instanceId,
      }),
    ).toBe(true)
    const leased = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: accountId },
      owner: { kind: 'RUN', runId: grant.runId, runFencingToken: grant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: worker.workerId,
      holderInstanceId: worker.instanceId,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(leased.ok).toBe(true)
    const reserved = await reserveObjectEvidence(handle.db, {
      runId,
      type: 'video',
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    expect(reserved.status).toBe('pending')
    const replacement = newId()
    await handle.db.update(workers).set({ instanceId: replacement }).where(eq(workers.id, worker.workerId))
    expect(await isolateOrphanedSessions(handle.db, worker.workerId, replacement)).toBeGreaterThanOrEqual(1)
    const lost = await markOrphanedRunVideoLost(handle.db, {
      workerId: worker.workerId,
      workerInstanceId: replacement,
    })
    expect(lost.marked).toBe(1)
    expect(lost.runIds).toContain(runId)
    const listed = await listRunEvidence(handle.db, runId)
    const video = listed.items.find((item) => item.type === 'video' && !item.attemptId)
    expect(video?.status).toBe('missing')
    expect(video?.missingReason).toBe(OBJECT_MISSING_REASONS.workerLost)
    const ttl = await settleExpiredPendingEvidence(handle.db, {
      pendingTtlSeconds: 3600,
      maxUploadAttempts: 3,
    })
    expect(ttl.marked).toBe(0)
  })

  it('删 Run 后视频对象进入 run_deleted 清理', async () => {
    const { runId } = await finishBrowserAttempt({
      evidencePolicy: { screenshot: 'off', video: 'off' },
    })
    const reserved = await reserveObjectEvidence(handle.db, {
      runId,
      type: 'video',
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    await commitStoredObject(handle.db, {
      id: reserved.objectKey!.split('/').at(-1)!,
      contentType: 'video/webm',
      byteSize: 8,
      digest: `sha256:${'ab'.repeat(32)}`,
    })
    await commitObjectEvidence(handle.db, {
      id: reserved.id,
      contentType: 'video/webm',
      byteSize: 8,
      digest: `sha256:${'ab'.repeat(32)}`,
    })
    await settleRunEvidence(handle.db, runId, { pendingTtlSeconds: 3600, maxUploadAttempts: 3 })
    await deleteRun(handle.db, runId, { id: actorId })
    const candidates = await listPurgeCandidates(handle.db, {
      now: new Date(),
      pendingTtlSeconds: 3600,
      limit: 100,
    })
    expect(candidates.some((row) => row.objectKey === reserved.objectKey && row.deleteRequestedAt)).toBe(true)
  })

  it('收尾路径源码不带 grant', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const evidence = readFileSync(resolve(import.meta.dirname, '../objects/evidence.ts'), 'utf8')
    expect(evidence).not.toMatch(/\bgrant\b/)
    expect(evidence).toContain('settleFinishedPendingRuns')
  })
})
