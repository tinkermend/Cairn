import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  browserSessions,
  claimRun,
  computeSnapshotDigest,
  createActionModule,
  listActionModuleVersions,
  publishActionModule,
  publishScenarioDraft,
  registerWorker,
  saveActionModuleDraft,
  saveScenarioDraft,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  expireStaleRunLeases,
  finishAttempt,
  getRun,
  listRunEvidence,
  newId,
  openIsolatedDb,
  requestRunCancel,
  runs,
  startAttempt,
  stepRuns,
  targets,
  yieldUnfinishedRun,
  type DbHandle,
} from '@cairn/db/testing'
import {
  DEFAULT_EXECUTOR_VERSIONS,
  DEFAULT_SESSION_POLICY,
  SESSION_OCCUPANCY_PROTOCOL,
  runGrantSchema,
  runSnapshotSchema,
  type ModuleContent,
  type ScenarioAuthoringDocumentV2,
  type Step,
} from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { ExecutionEngine } from './engine.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_eng`

const ids = {
  echo1: '00000000-0000-4000-8000-000000000071',
  delay: '00000000-0000-4000-8000-000000000072',
  echo2: '00000000-0000-4000-8000-000000000073',
  fail: '00000000-0000-4000-8000-000000000074',
  echoP: '00000000-0000-4000-8000-000000000075',
}

describe('ExecutionEngine（集成）', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let engine: ExecutionEngine
  let actorId: string
  let targetId: string
  let workerId: string
  let workerInstanceId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    engine = new ExecutionEngine(handle)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'engine-tester',
      email: `eng-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `eng-${SCHEMA.slice(-8)}`,
      name: '引擎夹具',
      entryUrl: 'https://example.com',
    })
    workerId = `eng-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  /** 等到该 Run 的第一个 Attempt 落库：取消要打在步骤进行中，不能靠固定 sleep 猜。 */
  async function waitForFirstAttempt(runId: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const live = await getRun(handle.db, runId)
      if (live.stepRuns.some((step) => step.attempts.length > 0)) return
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 10)
      await promise
    }
    throw new Error('Attempt 未在预期时间内开始')
  }

  async function cancelOtherClaimable(keepRunId?: string) {
    await handle.pool.query(
      `UPDATE runs
          SET status = 'CANCELLED',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING')
          AND ($1::uuid IS NULL OR id <> $1)`,
      [keepRunId ?? null],
    )
  }

  async function claimThis(runId: string) {
    await cancelOtherClaimable(runId)
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 30,
    })
    expect(grant?.runId).toBe(runId)
    return grant!
  }

  async function createAndRun(
    name: string,
    steps: Step[],
    input?: Record<string, string>,
    extras?: { inputs?: { key: string; label: string }[] },
  ) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name,
      steps,
      inputs: extras?.inputs,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      input,
      actor: { id: actorId },
    })
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    return getRun(handle.db, created.detail.id)
  }

  it('Echo → Delay → Echo 传递输出', async () => {
    const detail = await createAndRun('链路', [
      {
        id: ids.echo1,
        name: '写',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'greeting',
        input: { value: 'hello' },
      },
      {
        id: ids.delay,
        name: '等',
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 20 },
      },
      {
        id: ids.echo2,
        name: '读',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'again',
        input: { from: 'greeting' },
      },
    ])
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.greeting).toBe('hello')
    expect(detail.context.again).toBe('hello')
    expect(detail.stepRuns[2]?.attempts[0]?.output).toBe('hello')
    expect(detail.stepRuns.every((step) => step.status === 'SUCCEEDED')).toBe(true)
    expect(detail.snapshot.digest).toBe(computeSnapshotDigest(detail.snapshot))
    const evidence = await listRunEvidence(handle.db, detail.id)
    expect(evidence.items.some((item) => item.type === 'output')).toBe(true)
    expect(evidence.items.some((item) => item.type === 'screenshot' || item.type === 'trace')).toBe(false)
    expect(
      evidence.items
        .filter((item) => item.type === 'output')
        .every((item) => item.payload !== undefined && !item.objectKey),
    ).toBe(true)
  })

  it('RF04 惰性启动：Echo 链路不产生 browser_sessions，快照带平台默认 sessionPolicy', async () => {
    const detail = await createAndRun('惰性', [
      {
        id: newId(),
        name: 'echo',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 1 },
      },
    ])
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.snapshot.sessionPolicy).toEqual(DEFAULT_SESSION_POLICY)
    const sessions = await handle.db.select({ id: browserSessions.id }).from(browserSessions)
    expect(sessions).toEqual([])
    // 按需开会话：纯 Echo 不 acquire。无 playwright import 由 boundary 卡住
  })

  it('参数化 from 用 input 执行', async () => {
    const detail = await createAndRun(
      '参数化',
      [
        {
          id: ids.echoP,
          name: '回显单号',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'echoed',
          input: { from: 'orderId' },
        },
      ],
      { orderId: 'A-1' },
      { inputs: [{ key: 'orderId', label: '单号' }] },
    )
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.stepRuns[0]?.attempts[0]?.output).toBe('A-1')
  })

  it('Fail 可重试两次后失败即停', async () => {
    const detail = await createAndRun('失败', [
      {
        id: ids.fail,
        name: '注入失败',
        type: 'fail',
        effectType: 'READ_ONLY',
        policy: { retryLimit: 1 },
        input: { message: 'boom', category: 'EXECUTOR', retryable: true },
      },
      {
        id: ids.echo2,
        name: '不会跑到',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 1 },
      },
    ])
    expect(detail.status).toBe('FAILED')
    expect(detail.stepRuns[0]?.attempts).toHaveLength(2)
    expect(detail.stepRuns[1]?.status).toBe('SKIPPED')
    const evidence = await listRunEvidence(handle.db, detail.id)
    expect(evidence.items.some((item) => item.type === 'screenshot' || item.type === 'trace')).toBe(false)
  })

  it('SIDE_EFFECT + UNKNOWN 进入 NEEDS_REVIEW', async () => {
    const detail = await createAndRun('未知副作用', [
      {
        id: ids.fail,
        name: '失联',
        type: 'fail',
        effectType: 'SIDE_EFFECT',
        policy: { retryLimit: 2 },
        input: { message: '已发出', category: 'UNKNOWN', retryable: true },
      },
      {
        id: ids.echo1,
        name: '后续',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 1 },
      },
    ])
    expect(detail.status).toBe('NEEDS_REVIEW')
    expect(detail.stepRuns[0]?.attempts).toHaveLength(1)
    expect(detail.stepRuns[1]?.status).toBe('PENDING')
  })

  it('Delay 大于步骤超时 → TIMEOUT', async () => {
    const detail = await createAndRun('超时', [
      {
        id: ids.delay,
        name: '睡过头',
        type: 'delay',
        effectType: 'READ_ONLY',
        policy: { timeoutMs: 15 },
        input: { durationMs: 80 },
      },
    ])
    expect(detail.status).toBe('FAILED')
    expect(detail.stepRuns[0]?.attempts[0]?.error?.category).toBe('TIMEOUT')
  })

  it('QUEUED 取消后领取不到', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '取消队列',
      steps: [
        {
          id: ids.echo1,
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 1 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const cancelled = await requestRunCancel(handle.db, created.detail.id, { id: actorId })
    expect(cancelled.status).toBe('CANCELLED')
    await cancelOtherClaimable()
    expect(
      await claimRun(handle, { workerId, instanceId: workerInstanceId, leaseTtlSeconds: 30 }),
    ).toBeNull()
  })

  it('SIDE_EFFECT Delay 被 abort → NEEDS_REVIEW', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '中止副作用',
      steps: [
        {
          id: ids.delay,
          name: '副作用等待',
          type: 'delay',
          effectType: 'SIDE_EFFECT',
          input: { durationMs: 5_000 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await claimThis(created.detail.id)
    const controller = new AbortController()
    const running = engine.execute(created.detail.id, { grant, signal: controller.signal })
    await waitForFirstAttempt(created.detail.id)
    controller.abort()
    await running
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('NEEDS_REVIEW')
    expect(detail.stepRuns[0]?.attempts).toHaveLength(1)
  })

  it('SIDE_EFFECT Delay 超时 → NEEDS_REVIEW，不重试', async () => {
    const detail = await createAndRun('副作用超时', [
      {
        id: ids.delay,
        name: '副作用等待',
        type: 'delay',
        effectType: 'SIDE_EFFECT',
        policy: { timeoutMs: 15, retryLimit: 2 },
        input: { durationMs: 80 },
      },
    ])
    expect(detail.status).toBe('NEEDS_REVIEW')
    expect(detail.stepRuns[0]?.attempts).toHaveLength(1)
    expect(detail.stepRuns[0]?.attempts[0]?.error?.category).toBe('TIMEOUT')
  })

  it('from=constructor 不得取到 Object 构造函数', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '构造函数陷阱',
      compileMode: 'save',
      steps: [
        {
          id: ids.echoP,
          name: '读 constructor',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'got',
          input: { from: 'constructor' },
        },
      ],
      actor: { id: actorId },
    })
    const runId = newId()
    const snapshot = runSnapshotSchema.parse({
      schemaVersion: 1,
      runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      steps: [
        {
          id: ids.echoP,
          name: '读 constructor',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'got',
          input: { from: 'constructor' },
        },
      ],
      input: {},
      createdAt: new Date().toISOString(),
      executorVersions: { ...DEFAULT_EXECUTOR_VERSIONS },
    })
    const digest = computeSnapshotDigest(snapshot)
    await handle.db.insert(runs).values({
      id: runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      createdByConsoleAccountId: actorId,
      status: 'QUEUED',
      snapshot: { ...snapshot, digest },
      snapshotDigest: digest,
      context: {},
    })
    await handle.db.insert(stepRuns).values({
      id: newId(),
      runId,
      stepId: ids.echoP,
      ordinal: 0,
      status: 'PENDING',
    })
    const grant = await claimThis(runId)
    await engine.execute(runId, { grant })
    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('FAILED')
    expect(detail.stepRuns[0]?.attempts[0]?.error?.category).toBe('VALIDATION')
    expect(typeof detail.stepRuns[0]?.attempts[0]?.output).not.toBe('function')
  })

  it('RUNNING 中取消：在途步骤被中止，不出现迟到的 SUCCEEDED', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '运行中取消',
      steps: [
        {
          id: ids.delay,
          name: '慢步骤',
          type: 'delay',
          effectType: 'READ_ONLY',
          input: { durationMs: 5_000 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await claimThis(created.detail.id)

    const running = engine.execute(created.detail.id, { grant, cancelPollMs: 20 })
    await waitForFirstAttempt(created.detail.id)
    await requestRunCancel(handle.db, created.detail.id, { id: actorId })
    await running

    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.cancelRequested).toBe(true)
    expect(detail.status).toBe('CANCELLED')
    expect(detail.stepRuns.map((step) => step.status)).toEqual(['CANCELLED'])
    expect(detail.stepRuns[0]?.attempts.map((attempt) => attempt.status)).toEqual(['CANCELLED'])
    expect(detail.context).toEqual({})
  })

  it('执行器抛出的非中止异常记为 EXECUTOR，并按次数重试', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '执行器异常',
      steps: [
        {
          id: ids.delay,
          name: '抛错步骤',
          type: 'delay',
          effectType: 'IDEMPOTENT',
          policy: { retryLimit: 1 },
          input: { durationMs: 10 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await claimThis(created.detail.id)

    await engine.execute(created.detail.id, {
      grant,
      clock: {
        now: () => Date.now(),
        sleep: async () => {
          throw new Error('executor blew up')
        },
      },
    })

    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.stepRuns[0]?.attempts).toHaveLength(2)
    expect(detail.stepRuns[0]?.attempts[0]?.error?.category).toBe('EXECUTOR')
    expect(detail.stepRuns[0]?.status).toBe('FAILED')
    expect(detail.status).toBe('FAILED')
  })

  it('步骤都已终结但 Run 仍停在 RUNNING 时补写成功', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '补写成功',
      steps: [
        {
          id: ids.echo1,
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 1 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await claimThis(created.detail.id)
    await handle.pool.query(
      `UPDATE step_runs SET status = 'SUCCEEDED', finished_at = now() WHERE run_id = $1`,
      [created.detail.id],
    )

    await engine.execute(created.detail.id, { grant })

    expect((await getRun(handle.db, created.detail.id)).status).toBe('SUCCEEDED')
  })

  it('非法 Snapshot → FAILED，StepRun 全部 SKIPPED', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '坏快照',
      steps: [
        {
          id: ids.echo1,
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 1 },
        },
      ],
      actor: { id: actorId },
    })
    const runId = newId()
    await handle.db.insert(runs).values({
      id: runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      createdByConsoleAccountId: actorId,
      status: 'QUEUED',
      snapshot: { not: 'a snapshot' } as never,
      snapshotDigest: 'invalid',
      context: {},
    })
    await handle.db.insert(stepRuns).values({
      id: newId(),
      runId,
      stepId: ids.echo1,
      ordinal: 0,
      status: 'PENDING',
    })
    const grant = await claimThis(runId)
    await engine.execute(runId, { grant })
    const { rows: runRows } = await handle.pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [runId],
    )
    const { rows: stepRows } = await handle.pool.query<{ status: string }>(
      `SELECT status FROM step_runs WHERE run_id = $1`,
      [runId],
    )
    expect(runRows[0]?.status).toBe('FAILED')
    expect(stepRows.map((row) => row.status)).toEqual(['SKIPPED'])
  })

  it('接管后续跑：孤儿 READ_ONLY Attempt 取消后重开 Attempt，不假成功', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '接管续跑',
      steps: [
        {
          id: ids.echo1,
          name: '写',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'greeting',
          input: { value: 'hello' },
        },
        {
          id: ids.delay,
          name: '等',
          type: 'delay',
          effectType: 'READ_ONLY',
          input: { durationMs: 10 },
        },
        {
          id: ids.echo2,
          name: '读',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'again',
          input: { from: 'greeting' },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const runId = created.detail.id

    await cancelOtherClaimable(runId)
    await handle.pool.query(
      `UPDATE runs SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1`,
      [runId],
    )
    const oldLeaseId = newId()
    await handle.pool.query(
      `INSERT INTO run_leases (id, run_id, fencing_token, holder_worker_id, status, expires_at)
       VALUES ($1, $2, 1, $3, 'ACTIVE', now() + interval '30 seconds')`,
      [oldLeaseId, runId, workerId],
    )
    const oldGrant = runGrantSchema.parse({
      runId,
      leaseId: oldLeaseId,
      fencingToken: 1,
      holderWorkerId: workerId,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    })

    const s1 = await startAttempt(handle.db, {
      runId,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant: oldGrant,
    })
    await finishAttempt(handle.db, {
      runId,
      attemptId: s1!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: 'hello',
      context: { greeting: 'hello' },
      stepRunStatus: 'SUCCEEDED',
      grant: oldGrant,
    })
    const s2 = await startAttempt(handle.db, {
      runId,
      stepRunId: created.detail.stepRuns[1]!.id,
      inputPayload: { durationMs: 10 },
      grant: oldGrant,
    })
    expect(s2).not.toBeNull()

    await handle.pool.query(`UPDATE run_leases SET expires_at = now() - interval '2 seconds' WHERE id = $1`, [
      oldLeaseId,
    ])
    await expireStaleRunLeases(handle.db, { limit: 10, maxRecoveries: 3 })
    expect((await getRun(handle.db, runId)).status).toBe('RECOVERING')

    const newGrant = await claimThis(runId)
    expect(newGrant.fencingToken).toBeGreaterThan(1)
    await engine.execute(runId, { grant: newGrant })

    const after = await getRun(handle.db, runId)
    expect(after.status).toBe('SUCCEEDED')
    expect(after.stepRuns.every((step) => step.status === 'SUCCEEDED')).toBe(true)
    expect(after.stepRuns[1]!.attempts.some((a) => a.status === 'CANCELLED')).toBe(true)
    expect(after.stepRuns[1]!.attempts.some((a) => a.status === 'SUCCEEDED')).toBe(true)
    expect(after.context.again).toBe('hello')
  })

  /**
   * 接管时副作用步骤的结果无法确认（验收 13）。
   *
   * 这是整套恢复里最危险的分支：Worker 被 kill 在副作用步骤中途，平台不知道那次操作
   * 到底有没有生效。此时只能停下来交给人，绝不允许当成"重试一次就好"。
   */
  it('接管时副作用孤儿 Attempt：Run 进 NEEDS_REVIEW，后续步骤不续跑', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '接管副作用',
      steps: [
        {
          id: ids.echo1,
          name: '写',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'greeting',
          input: { value: 'hello' },
        },
        {
          id: ids.delay,
          name: '提交订单',
          type: 'delay',
          effectType: 'SIDE_EFFECT',
          input: { durationMs: 10 },
        },
        {
          id: ids.echo2,
          name: '读',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'again',
          input: { from: 'greeting' },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const runId = created.detail.id
    const oldGrant = await forceRunningGrant(runId)

    const s1 = await startAttempt(handle.db, {
      runId,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant: oldGrant,
    })
    await finishAttempt(handle.db, {
      runId,
      attemptId: s1!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: 'hello',
      context: { greeting: 'hello' },
      stepRunStatus: 'SUCCEEDED',
      grant: oldGrant,
    })
    // 副作用步骤的 Attempt 开着不收尾：等同持有者被 kill 在这一步中间。
    const s2 = await startAttempt(handle.db, {
      runId,
      stepRunId: created.detail.stepRuns[1]!.id,
      inputPayload: { durationMs: 10 },
      grant: oldGrant,
    })
    expect(s2).not.toBeNull()

    await handle.pool.query(`UPDATE run_leases SET expires_at = now() - interval '2 seconds' WHERE id = $1`, [
      oldGrant.leaseId,
    ])
    await expireStaleRunLeases(handle.db, { limit: 10, maxRecoveries: 3 })
    expect((await getRun(handle.db, runId)).status).toBe('RECOVERING')

    const newGrant = await claimThis(runId)
    await engine.execute(runId, { grant: newGrant })

    const after = await getRun(handle.db, runId)
    expect(after.status).toBe('NEEDS_REVIEW')
    // 副作用那一步判失败且写明原因，后面的步骤一步都不许跑
    expect(after.stepRuns.map((step) => step.status)).toEqual(['SUCCEEDED', 'FAILED', 'PENDING'])
    const orphan = after.stepRuns[1]!.attempts.find((attempt) => attempt.id === s2!.attemptId)
    expect(orphan?.status).toBe('FAILED')
    expect(orphan?.error?.safeMessage).toBe('接管时副作用步骤结果未确认')
    expect(after.stepRuns[1]!.attempts.some((attempt) => attempt.status === 'SUCCEEDED')).toBe(false)
    expect(after.context.again).toBeUndefined()

    // 进核查即交还租约：不许把 Run 攥在一个不会再推进它的持有者手里
    const { rows } = await handle.pool.query<{ status: string; release_reason: string }>(
      `SELECT status, release_reason FROM run_leases WHERE id = $1`,
      [newGrant.leaseId],
    )
    expect(rows[0]?.status).toBe('RELEASED')
    expect(rows[0]?.release_reason).toBe('run_halted')
  })

  /**
   * 停机中止不是取消（S4）。
   *
   * 外部信号只说明本实例要走，Run 的事实没有结论。Engine 不得写终态，
   * 之后 `yieldUnfinishedRun` 把 Run 交回 RECOVERING，同伴接管续跑。
   */
  it('停机中止：不写终态，交回后接管续跑到成功', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '停机交回',
      steps: [
        {
          id: ids.delay,
          name: '慢步骤',
          type: 'delay',
          effectType: 'READ_ONLY',
          input: { durationMs: 5_000 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const runId = created.detail.id
    const grant = await claimThis(runId)

    const controller = new AbortController()
    const running = engine.execute(runId, { grant, signal: controller.signal, cancelPollMs: 20 })
    await waitForFirstAttempt(runId)
    controller.abort()
    await running

    // 中止之后：Run 仍是 RUNNING，Attempt 仍开着，租约也还在——一个事实都没被改写
    const stopped = await getRun(handle.db, runId)
    expect(stopped.status).toBe('RUNNING')
    expect(stopped.cancelRequested).toBe(false)
    expect(stopped.stepRuns[0]?.attempts.map((attempt) => attempt.status)).toEqual(['RUNNING'])

    // 停机路径把它交回
    await yieldUnfinishedRun(handle.db, grant)
    const yielded = await getRun(handle.db, runId)
    expect(yielded.status).toBe('RECOVERING')

    // 同伴接管：READ_ONLY 孤儿取消后重开，最终成功。滚动发布不该让用户的 Run 死掉。
    const takeover = await claimThis(runId)
    expect(takeover.fencingToken).toBeGreaterThan(grant.fencingToken)
    await engine.execute(runId, { grant: takeover })

    const after = await getRun(handle.db, runId)
    expect(after.status).toBe('SUCCEEDED')
    expect(after.stepRuns[0]?.attempts.map((attempt) => attempt.status)).toEqual(['CANCELLED', 'SUCCEEDED'])
  })

  it('AMB-09：含 moduleManifest 的 Run 只给声明协议的 Worker，展开后由现有引擎执行', async () => {
    const echoStepId = newId()
    const moduleContent: ModuleContent = {
      contract: {
        inputs: [{ key: 'msg', label: '消息', valueType: 'string', required: true }],
        outputs: [{ key: 'out', label: '输出', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [
          { meaning: '验证输出', verification: { kind: 'output_required', outputKey: 'out' } },
        ],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [
            {
              id: echoStepId,
              name: '回显模块输入',
              type: 'echo',
              effectType: 'READ_ONLY',
              input: { from: 'msg' },
              outputKey: 'internal_out',
            },
          ],
          outputMapping: { out: 'internal_out' },
        },
      ],
    }
    const createdModule = await createActionModule(handle.db, {
      targetId,
      key: 'worker.echo',
      name: 'Worker 回显模块',
      idempotencyKey: newId(),
      actor: { id: actorId },
    })
    await saveActionModuleDraft(handle.db, createdModule.id, {
      baseRevision: 0,
      content: moduleContent,
      actor: { id: actorId },
    })
    await publishActionModule(handle.db, createdModule.id, {
      idempotencyKey: newId(),
      expectedRevision: 1,
      actor: { id: actorId },
    })
    const moduleVersionId = (await listActionModuleVersions(handle.db, createdModule.id)).items[0]!.id

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '模块展开执行',
      steps: [
        {
          id: newId(),
          name: '占位',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'seed' },
        },
      ],
      actor: { id: actorId },
    })
    const invocationId = newId()
    const v2Draft: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'module',
          invocationId,
          moduleId: createdModule.id,
          moduleVersionId,
          implementationKey: 'default',
          inputBindings: { msg: { kind: 'literal', value: 'hello-mod' } },
          outputBindings: { out: 'mod_out' },
        },
      ],
    }
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: v2Draft,
      actor: { id: actorId },
    })
    const published = await publishScenarioDraft(handle.db, scenario.id, {
      revision: 2,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      scenarioVersionId: published.published!.versionId,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.moduleManifest?.entries).toHaveLength(1)
    expect(created.detail.snapshot.steps).toHaveLength(1)
    expect(created.detail.snapshot.steps[0]?.effectType).toBe('READ_ONLY')

    const oldWorkerId = `eng-old-${SCHEMA.slice(-8)}`
    const oldInstanceId = newId()
    await registerWorker(handle.db, {
      workerId: oldWorkerId,
      instanceId: oldInstanceId,
      capacity: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    await cancelOtherClaimable(created.detail.id)
    expect(
      await claimRun(handle, {
        workerId: oldWorkerId,
        instanceId: oldInstanceId,
        leaseTtlSeconds: 30,
      }),
    ).toBeNull()

    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.mod_out).toBe('hello-mod')
    expect(detail.stepRuns).toHaveLength(1)
    expect(detail.stepRuns[0]?.status).toBe('SUCCEEDED')
    expect(detail.snapshot.moduleManifest?.entries[0]?.moduleKey).toBe('worker.echo')
    expect(detail.snapshot.moduleManifest?.entries[0]?.expandedStepIds).toEqual([
      detail.stepRuns[0]?.stepId,
    ])
  })

  it('AMB-07：展开后 SIDE_EFFECT 步骤保持 effectType，结果未知仍进核查', async () => {
    const failId = newId()
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '展开副作用核查',
      compileMode: 'save',
      steps: [
        {
          id: failId,
          name: '失联提交',
          type: 'fail',
          effectType: 'SIDE_EFFECT',
          policy: { retryLimit: 2 },
          input: { message: '已发出', category: 'UNKNOWN', retryable: true },
        },
      ],
      actor: { id: actorId },
    })
    const runId = newId()
    const invocationId = newId()
    const snapshot = runSnapshotSchema.parse({
      schemaVersion: 1,
      runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      steps: [
        {
          id: failId,
          name: '失联提交',
          type: 'fail',
          effectType: 'SIDE_EFFECT',
          policy: { retryLimit: 2 },
          input: { message: '已发出', category: 'UNKNOWN', retryable: true },
        },
      ],
      moduleManifest: {
        entries: [
          {
            invocationId,
            ordinal: 0,
            name: '提交模块',
            moduleId: newId(),
            moduleKey: 'worker.submit',
            moduleVersionId: newId(),
            versionNo: 1,
            contentDigest: 'sha256:content',
            contractDigest: 'sha256:contract',
            implementationDigest: 'sha256:impl',
            implementationKey: 'default',
            executionMode: 'DETERMINISTIC',
            effectCeiling: 'SIDE_EFFECT',
            expandedStepIds: [failId],
            internalToExpanded: { [failId]: failId },
            preconditionStepIds: [],
            postconditionStepIds: [],
            outputRequired: [],
            inputBindingsDigest: 'sha256:bindings',
          },
        ],
      },
      input: {},
      createdAt: new Date().toISOString(),
      executorVersions: { ...DEFAULT_EXECUTOR_VERSIONS },
    })
    const digest = computeSnapshotDigest(snapshot)
    await handle.db.insert(runs).values({
      id: runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      createdByConsoleAccountId: actorId,
      status: 'QUEUED',
      snapshot: { ...snapshot, digest },
      snapshotDigest: digest,
      context: {},
    })
    await handle.db.insert(stepRuns).values({
      id: newId(),
      runId,
      stepId: failId,
      ordinal: 0,
      status: 'PENDING',
    })
    const grant = await claimThis(runId)
    await engine.execute(runId, { grant })
    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('NEEDS_REVIEW')
    expect(detail.snapshot.steps[0]?.effectType).toBe('SIDE_EFFECT')
    expect(detail.snapshot.moduleManifest?.entries).toHaveLength(1)
    expect(detail.stepRuns[0]?.attempts).toHaveLength(1)
  })

  async function insertCandidateRun(input: {
    name: string
    first: Step
    leftover: Step
    second: Step
    after?: Step
  }) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: input.name,
      compileMode: 'save',
      steps: [input.first, input.leftover, input.second, ...(input.after ? [input.after] : [])],
      actor: { id: actorId },
    })
    const testModule = await createActionModule(handle.db, {
      targetId,
      key: `worker.fallback.m${newId().replace(/-/g, '').toLowerCase()}`,
      name: '只读回退',
      idempotencyKey: newId(),
      actor: { id: actorId },
    })
    const runId = newId()
    const invocationId = newId()
    const steps = [input.first, input.leftover, input.second, ...(input.after ? [input.after] : [])]
    const snapshot = runSnapshotSchema.parse({
      schemaVersion: 1,
      runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      steps,
      candidateGroups: {
        groups: [
          {
            groupId: invocationId,
            invocationId,
            alternatives: [
              {
                implementationKey: 'default',
                implementationDigest: 'sha256:default',
                stepIds: [input.first.id, input.leftover.id],
                postconditionStepIds: [],
                outputStaging: { exposed: 'm0_alt_out' },
              },
              {
                implementationKey: 'alt',
                implementationDigest: 'sha256:alt',
                stepIds: [input.second.id],
                postconditionStepIds: [],
                outputStaging: { exposed: 'm0_alt_out' },
              },
            ],
          },
        ],
      },
      moduleManifest: {
        entries: [
          {
            invocationId,
            ordinal: 0,
            name: '只读回退',
            moduleId: testModule.id,
            moduleKey: testModule.key,
            contentDigest: 'sha256:content',
            contractDigest: 'sha256:contract',
            implementationDigest: 'sha256:impl',
            implementationKey: 'default',
            executionMode: 'DETERMINISTIC',
            effectCeiling: 'READ_ONLY',
            expandedStepIds: [input.first.id, input.leftover.id, input.second.id],
            internalToExpanded: {},
            outputRequired: ['out'],
            inputBindingsDigest: 'sha256:bindings',
          },
        ],
        candidateGroups: [
          {
            groupId: invocationId,
            invocationId,
            alternatives: [
              {
                implementationKey: 'default',
                implementationDigest: 'sha256:default',
                stepIds: [input.first.id, input.leftover.id],
                postconditionStepIds: [],
                outputStaging: { exposed: 'm0_alt_out' },
              },
              {
                implementationKey: 'alt',
                implementationDigest: 'sha256:alt',
                stepIds: [input.second.id],
                postconditionStepIds: [],
                outputStaging: { exposed: 'm0_alt_out' },
              },
            ],
          },
        ],
      },
      input: {},
      createdAt: new Date().toISOString(),
      executorVersions: { ...DEFAULT_EXECUTOR_VERSIONS },
    })
    const digest = computeSnapshotDigest(snapshot)
    await handle.db.insert(runs).values({
      id: runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      createdByConsoleAccountId: actorId,
      status: 'QUEUED',
      snapshot: { ...snapshot, digest },
      snapshotDigest: digest,
      context: {},
    })
    await handle.db.insert(stepRuns).values(steps.map((step, ordinal) => ({
      id: newId(),
      runId,
      stepId: step.id,
      ordinal,
      status: 'PENDING' as const,
    })))
    return { runId, invocationId }
  }

  it('AMF-05/08 模块原因回退到下一候选并提交暴露输出', async () => {
    const first = {
      id: newId(),
      name: '首选失败',
      type: 'fail' as const,
      effectType: 'READ_ONLY' as const,
      policy: { retryLimit: 0 },
      input: { message: '定位失败', code: 'FAIL', category: 'EXECUTOR' as const, retryable: false },
    }
    const leftover = {
      id: newId(),
      name: '首选剩余',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { value: 'should-skip' },
    }
    const second = {
      id: newId(),
      name: '回退成功',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      outputKey: 'm0_alt_out',
      input: { value: 'from-alt' },
    }
    const after = {
      id: newId(),
      name: '读暴露输出',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      outputKey: 'seen',
      input: { from: 'exposed' },
    }
    const { runId, invocationId } = await insertCandidateRun({
      name: '回退提交',
      first,
      leftover,
      second,
      after,
    })
    const grant = await claimThis(runId)
    await engine.execute(runId, { grant })
    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.exposed).toBe('from-alt')
    expect(detail.context.seen).toBe('from-alt')
    expect(detail.stepRuns.find((item) => item.stepId === leftover.id)?.status).toBe('SKIPPED')
    expect(detail.stepRuns.find((item) => item.stepId === second.id)?.status).toBe('SUCCEEDED')
    const evidence = await listRunEvidence(handle.db, runId)
    expect(evidence.items.some((item) => {
      const payload = item.payload as { protocol?: string; invocationId?: string; selected?: string } | undefined
      return payload?.protocol === 'module.selectionDecision@1' && payload.invocationId === invocationId && payload.selected === 'alt'
    })).toBe(true)
  })

  it('AMF-06 外部原因不回退', async () => {
    const first = {
      id: newId(),
      name: '认证超时',
      type: 'fail' as const,
      effectType: 'READ_ONLY' as const,
      policy: { retryLimit: 0 },
      input: { message: '认证超时', code: 'SESSION_AUTH_TIMEOUT', category: 'INFRASTRUCTURE' as const, retryable: false },
    }
    const leftover = {
      id: newId(),
      name: '首选剩余',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { value: 'skip' },
    }
    const second = {
      id: newId(),
      name: '不应执行',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      outputKey: 'm0_alt_out',
      input: { value: 'from-alt' },
    }
    const { runId } = await insertCandidateRun({ name: '外部不回退', first, leftover, second })
    const grant = await claimThis(runId)
    await engine.execute(runId, { grant })
    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('FAILED')
    expect(detail.stepRuns.find((item) => item.stepId === second.id)?.status).toBe('SKIPPED')
    expect(detail.context.exposed).toBeUndefined()
  })

  it('AMF-07 核查不回退', async () => {
    const first = {
      id: newId(),
      name: '结果未知',
      type: 'fail' as const,
      effectType: 'SIDE_EFFECT' as const,
      policy: { retryLimit: 0 },
      input: { message: '已发出', code: 'SIDE_EFFECT_UNKNOWN', category: 'UNKNOWN' as const, retryable: false },
    }
    const leftover = {
      id: newId(),
      name: '首选剩余',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { value: 'skip' },
    }
    const second = {
      id: newId(),
      name: '不应执行',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { value: 'from-alt' },
    }
    const { runId } = await insertCandidateRun({ name: '核查不回退', first, leftover, second })
    const grant = await claimThis(runId)
    await engine.execute(runId, { grant })
    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('NEEDS_REVIEW')
    expect(detail.stepRuns.find((item) => item.stepId === second.id)?.status).toBe('SKIPPED')
  })

  it('AMF-10 未声明候选组协议的 Worker 不领取', async () => {
    const first = {
      id: newId(),
      name: '首选',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { value: 'a' },
    }
    const leftover = {
      id: newId(),
      name: '剩余',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { value: 'b' },
    }
    const second = {
      id: newId(),
      name: '备选',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { value: 'c' },
    }
    const { runId } = await insertCandidateRun({ name: '协议闸门', first, leftover, second })
    const oldWorkerId = `old-cg-${SCHEMA.slice(-8)}`
    const oldInstanceId = newId()
    await registerWorker(handle.db, {
      workerId: oldWorkerId,
      instanceId: oldInstanceId,
      capacity: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, 'snapshot.moduleManifest@1'],
    })
    await cancelOtherClaimable(runId)
    expect(
      await claimRun(handle, {
        workerId: oldWorkerId,
        instanceId: oldInstanceId,
        leaseTtlSeconds: 30,
      }),
    ).toBeNull()
    const grant = await claimThis(runId)
    expect(grant.runId).toBe(runId)
  })

  /** 把 Run 推到 RUNNING 并伪造一份有效 grant：模拟"持有者已经跑了一半"。 */
  async function forceRunningGrant(runId: string) {
    await cancelOtherClaimable(runId)
    await handle.pool.query(
      `UPDATE runs SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1`,
      [runId],
    )
    const leaseId = newId()
    const { rows } = await handle.pool.query<{ token: number }>(
      `SELECT COALESCE(MAX(fencing_token), 0) + 1 AS token FROM run_leases WHERE run_id = $1`,
      [runId],
    )
    const token = Number(rows[0]!.token)
    await handle.pool.query(
      `INSERT INTO run_leases (id, run_id, fencing_token, holder_worker_id, status, expires_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now() + interval '30 seconds')`,
      [leaseId, runId, token, workerId],
    )
    return runGrantSchema.parse({
      runId,
      leaseId,
      fencingToken: token,
      holderWorkerId: workerId,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    })
  }
})
