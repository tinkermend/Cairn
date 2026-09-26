import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor, databaseNow, afterSeconds } from '../native.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Step } from '@cairn/shared'
import {
  appendScenarioVersion,
  claimRun,
  computeSnapshotDigest,
  createRunWithSnapshot,
  createScenarioWithVersion,
  deleteScenario,
  finishAttempt,
  finishRunIfDrained,
  getRun,
  listRunEvidence,
  listScenarioVersions,
  loadRunControlState,
  mapPgRestriction,
  openIsolatedDb,
  requestRunCancel,
  startAttempt,
  updateScenarioMeta,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
let consoleAccounts = pg_consoleAccounts
import { runs as pg_runs, stepRuns as pg_stepRuns } from '../schema/execution.js'
let runs = pg_runs
let stepRuns = pg_stepRuns
let attempts = schemaFor({}).attempts
import { targetAccounts as pg_targetAccounts, targets as pg_targets } from '../schema/targets.js'
let targetAccounts = pg_targetAccounts
let targets = pg_targets
import { forceGrantForRun, seedWorker } from './lease-harness.js'
import { resetChangeHintPublisher, setChangeHintPublisher, type ChangeHintDraft } from '../observe/hint.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_exec`

const echoId = '00000000-0000-4000-8000-000000000061'
const echoStep: Step = {
  id: echoId,
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'greeting',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 执行账本 Repository（集成）', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    ;({ consoleAccounts, runs, stepRuns, attempts, targetAccounts, targets } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'tester',
      email: `exec-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `exec-${SCHEMA.slice(-6)}`,
      name: '执行夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('创建场景与 Run：摘要相等，幂等命中不重置', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '回显一次',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const first = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      idempotencyKey: 'idem-key-01',
      actor: { id: actorId },
    })
    expect(first.created).toBe(true)
    expect(first.detail.status).toBe('QUEUED')
    expect(first.detail.snapshot.allowedOrigins).toEqual(['https://example.com'])
    expect(computeSnapshotDigest(first.detail.snapshot)).toBe(first.detail.snapshot.digest)
    const [digestRow] = await handle.db
      .select({ snapshotDigest: runs.snapshotDigest })
      .from(runs)
      .where(eq(runs.id, first.detail.id))
    expect(digestRow?.snapshotDigest).toBe(first.detail.snapshot.digest)

    const again = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      idempotencyKey: 'idem-key-01',
      actor: { id: actorId },
    })
    expect(again.created).toBe(false)
    expect(again.detail.id).toBe(first.detail.id)
    expect(again.detail.status).toBe('QUEUED')

    await expect(
      createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        input: { orderId: 'other' },
        idempotencyKey: 'idem-key-01',
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'RUN_IDEMPOTENCY_CONFLICT' })
  })

  it('仅读取 Run 控制状态，不返回快照或上下文', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '运行控制状态',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const deadlineAt = new Date(Date.now() + 60_000)
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      deadlineAt,
      actor: { id: actorId },
    })
    const runId = created.detail.id
    expect(await loadRunControlState(handle.db, runId)).toEqual({
      id: runId,
      status: 'QUEUED',
      cancelRequestedAt: null,
      deadlineAt,
    })

    const cancelRequestedAt = new Date()
    await handle.db.update(runs).set({ status: 'RUNNING', cancelRequestedAt }).where(eq(runs.id, runId))
    expect(await loadRunControlState(handle.db, runId)).toEqual({
      id: runId,
      status: 'RUNNING',
      cancelRequestedAt,
      deadlineAt,
    })
    expect(await loadRunControlState(handle.db, newId())).toBeNull()
  })

  it('只把取消及状态变化标记为运行控制提示', async () => {
    const hints: ChangeHintDraft[] = []
    setChangeHintPublisher((hint) => hints.push(hint))
    try {
      const scenario = await createScenarioWithVersion(handle.db, {
        targetId,
        name: '运行控制提示',
        steps: [echoStep],
        actor: { id: actorId },
      })
      const created = await createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        actor: { id: actorId },
      })
      expect(hints).toContainEqual(expect.objectContaining({ runId: created.detail.id, runControlChanged: false }))

      await requestRunCancel(handle.db, created.detail.id, { id: actorId })
      expect(hints).toContainEqual(expect.objectContaining({ runId: created.detail.id, runControlChanged: true }))
    } finally {
      resetChangeHintPublisher()
    }
  })

  it('参数化 from：保存成功，缺 input 创建失败', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '参数化',
      inputs: [{ key: 'orderId', label: '单号' }],
      steps: [
        {
          id: '00000000-0000-4000-8000-000000000062',
          name: '回显单号',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { from: 'orderId' },
        },
      ],
      actor: { id: actorId },
    })
    await expect(
      createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } }),
    ).rejects.toMatchObject({ code: 'SCENARIO_UNRESOLVED_REF', kind: 'bad_request' })
  })

  it('只改名不产生新版本；改步骤才追加版本且旧 Run 快照不变', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '将改名',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const digest = created.detail.snapshot.digest
    const steps = created.detail.snapshot.steps

    const renamed = await updateScenarioMeta(handle.db, scenario.id, {
      name: '已改名',
      actor: { id: actorId },
    })
    expect(renamed.latestVersionNo).toBe(1)
    expect((await listScenarioVersions(handle.db, scenario.id)).items).toHaveLength(1)

    const next = await appendScenarioVersion(handle.db, scenario.id, {
      steps: [{ ...echoStep, name: '回显改写', input: { value: 'changed' } }],
      actor: { id: actorId },
    })
    expect(next.latestVersionNo).toBe(2)

    const old = await getRun(handle.db, created.detail.id)
    expect(old.snapshot.digest).toBe(digest)
    expect(old.snapshot.steps).toEqual(steps)
  })

  it('停用 Target / 场景后不能新建绑定', async () => {
    const disabledTargetId = newId()
    await handle.db.insert(targets).values({
      id: disabledTargetId,
      code: `off-${SCHEMA.slice(-6)}`,
      name: '停用目标',
      entryUrl: 'https://example.com',
      status: 'disabled',
    })
    await expect(
      createScenarioWithVersion(handle.db, {
        targetId: disabledTargetId,
        name: '不该创建',
        steps: [echoStep],
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'TARGET_DISABLED' })

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '随后停用',
      steps: [echoStep],
      actor: { id: actorId },
    })
    await updateScenarioMeta(handle.db, scenario.id, { status: 'disabled', actor: { id: actorId } })
    await expect(
      createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } }),
    ).rejects.toMatchObject({ code: 'SCENARIO_DISABLED' })
  })

  it('改 snapshot 被触发器拒绝；关闭 Attempt 不可改', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '触发器',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    await expect(
      handle.db.update(runs).set({ snapshot: { ...created.detail.snapshot, x: 1 } as never }).where(eq(runs.id, created.detail.id)),
    ).rejects.toSatisfy((error: Error) => String(error.cause ?? error).includes('immutable'))

    const stepId = created.detail.stepRuns[0]!.id
    const attemptId = newId()
    await handle.db.insert(attempts).values({ id: attemptId, stepRunId: stepId, attemptNo: 1, status: 'SUCCEEDED', startedAt: new Date(), finishedAt: new Date() })
    await expect(
      handle.db.update(attempts).set({ status: 'FAILED' }).where(eq(attempts.id, attemptId)),
    ).rejects.toSatisfy((error: Error) => String(error.cause ?? error).includes('immutable'))
  })

  it('先失败后成功保留两次 Attempt，StepRun 为 SUCCEEDED', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '重试成功',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const stepRunId = created.detail.stepRuns[0]!.id
    const first = await startAttempt(handle.db, { runId: created.detail.id, stepRunId, inputPayload: 'hello', grant })
    expect(first).not.toBeNull()
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: first!.attemptId,
      attemptStatus: 'FAILED',
      error: { code: 'FAIL', category: 'EXECUTOR', retryable: true, safeMessage: '先失败' },
      stepRunStatus: 'RUNNING',
      grant,
    })
    const second = await startAttempt(handle.db, { runId: created.detail.id, stepRunId, inputPayload: 'hello', grant })
    expect(second).not.toBeNull()
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: second!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: 'hello',
      context: { greeting: 'hello' },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
    })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.stepRuns[0]?.status).toBe('SUCCEEDED')
    expect(detail.stepRuns[0]?.attempts).toHaveLength(2)
    expect(detail.stepRuns[0]?.attempts.map((item) => item.status)).toEqual(['FAILED', 'SUCCEEDED'])
  })

  it('finishAttempt 注入失败后没有成功而无 output Evidence', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '回滚',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    await expect(
      finishAttempt(handle.db, {
        runId: created.detail.id,
        attemptId: started!.attemptId,
        attemptStatus: 'SUCCEEDED',
        output: 'hello',
        context: { greeting: 'hello' },
        stepRunStatus: 'SUCCEEDED',
        runStatus: 'SUCCEEDED',
        grant,
        injectFailure: new Error('injected'),
      }),
    ).rejects.toThrow('injected')

    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('RUNNING')
    expect(detail.stepRuns[0]?.status).toBe('RUNNING')
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    expect(evidence.items.some((item) => item.type === 'output')).toBe(false)
    expect(evidence.items.some((item) => item.type === 'input')).toBe(true)
  })

  it('已关闭 Attempt 再 finish 为 0 行', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '迟到回调',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    const first = await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'CANCELLED',
      error: { code: 'CANCELLED', category: 'CANCELLED', retryable: false, safeMessage: '取消' },
      stepRunStatus: 'CANCELLED',
      runStatus: 'CANCELLED',
      cancelPending: true,
      grant,
    })
    expect(first.updated).toBe(true)
    const late = await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: 'hello',
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
    })
    expect(late.updated).toBe(false)
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('CANCELLED')
    expect(detail.stepRuns[0]?.attempts[0]?.status).toBe('CANCELLED')
  })

  it('取消请求到达后，迟到的成功被改写成取消', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '取消改写',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    await requestRunCancel(handle.db, created.detail.id, { id: actorId })

    const result = await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: 'hello',
      context: { greeting: 'hello' },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
    })

    expect(result).toEqual({ updated: true, cancelled: true })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('CANCELLED')
    expect(detail.context).toEqual({})
    expect(detail.stepRuns[0]?.status).toBe('CANCELLED')
    expect(detail.stepRuns[0]?.attempts[0]?.status).toBe('CANCELLED')
    expect(detail.stepRuns[0]?.attempts[0]?.output).toBeNull()
    expect(detail.stepRuns[0]?.attempts[0]?.error?.category).toBe('CANCELLED')
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    expect(evidence.items.some((item) => item.type === 'output')).toBe(false)
    expect(evidence.items.some((item) => item.type === 'error')).toBe(true)
  })

  it('副作用结果未知优先于取消：不被洗成干净终态', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '未知优先',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    await requestRunCancel(handle.db, created.detail.id, { id: actorId })

    const result = await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'FAILED',
      error: { code: 'UNKNOWN', category: 'UNKNOWN', retryable: false, safeMessage: '结果未确认' },
      stepRunStatus: 'FAILED',
      runStatus: 'NEEDS_REVIEW',
      grant,
    })

    expect(result).toEqual({ updated: true, cancelled: false })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('NEEDS_REVIEW')
    expect(detail.stepRuns[0]?.attempts[0]?.error?.category).toBe('UNKNOWN')
  })

  it('finishRunIfDrained 只在步骤全部成功且无取消请求时补写成功', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '补写终态',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)

    // 还有 PENDING 步骤：不得判成功
    expect((await finishRunIfDrained(handle.db, grant)).finished).toBe(false)

    await handle.db.update(stepRuns).set({ status: 'SUCCEEDED' }).where(eq(stepRuns.runId, created.detail.id))
    expect((await finishRunIfDrained(handle.db, grant)).finished).toBe(true)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('SUCCEEDED')
    // 已是终态：不再重复写
    expect((await finishRunIfDrained(handle.db, grant)).finished).toBe(false)

    // 有取消请求时不判成功
    const cancelledRun = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const cancelGrant = await forceGrantForRun(handle, cancelledRun.detail.id, worker.workerId)
    await handle.db.update(stepRuns).set({ status: 'SUCCEEDED' }).where(eq(stepRuns.runId, cancelledRun.detail.id))
    await requestRunCancel(handle.db, cancelledRun.detail.id, { id: actorId })
    expect((await finishRunIfDrained(handle.db, cancelGrant)).finished).toBe(false)
    expect((await getRun(handle.db, cancelledRun.detail.id)).status).toBe('RUNNING')
  })

  it('停用步骤建 Run 即跳过，成功与跳过混合可补写成功；全部停用拒绝建 Run', async () => {
    const disabledEcho: Step = {
      ...echoStep,
      id: '00000000-0000-4000-8000-000000000062',
      name: '停用回显',
      outputKey: 'later',
      disabled: true,
    }
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '停用收尾',
      steps: [echoStep, disabledEcho],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(created.detail.stepRuns.map((step) => step.status)).toEqual(['PENDING', 'SKIPPED'])
    expect(created.detail.stepRuns[1]?.finishedAt).toBeTruthy()

    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    expect((await finishRunIfDrained(handle.db, grant)).finished).toBe(false)
    await handle.db
      .update(stepRuns)
      .set({ status: 'SUCCEEDED' })
      .where(eq(stepRuns.id, created.detail.stepRuns[0]!.id))
    expect((await finishRunIfDrained(handle.db, grant)).finished).toBe(true)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('SUCCEEDED')

    // 绕过编译拦截建出的全停用版本：建 Run 时挡住，否则没有一步能成功，Run 收不了尾。
    const allDisabled = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '全部停用',
      steps: [{ ...echoStep, disabled: true }],
      actor: { id: actorId },
      compileMode: 'save',
    })
    await expect(
      createRunWithSnapshot(handle.db, { scenarioId: allDisabled.id, actor: { id: actorId } }),
    ).rejects.toMatchObject({ code: 'SCENARIO_ALL_STEPS_DISABLED', kind: 'bad_request' })
  })

  it('删除仍有活跃 Run 的场景 → RUN_NOT_TERMINAL；23503 兜底可映射', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '删不掉',
      steps: [echoStep],
      actor: { id: actorId },
    })
    await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } })
    await expect(deleteScenario(handle.db, scenario.id, { id: actorId })).rejects.toMatchObject({
      code: 'RUN_NOT_TERMINAL',
    })

    const accountId = newId()
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '被引用',
      username: `u-${accountId.slice(0, 8)}`,
    })
    const withAccount = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '带账号',
      steps: [echoStep],
      actor: { id: actorId },
    })
    await createRunWithSnapshot(handle.db, {
      scenarioId: withAccount.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    try {
      await handle.db.delete(targetAccounts).where(eq(targetAccounts.id, accountId))
      expect.unreachable()
    } catch (error) {
      expect(mapPgRestriction(error, 'target_account')).toMatchObject({ code: 'TARGET_ACCOUNT_HAS_RUNS' })
    }
  })

  it('finishAttempt 失败时把定位诊断和截图缺失原因写成独立证据', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '定位失败证据',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'FAILED',
      error: {
        code: 'TARGET_NOT_FOUND',
        category: 'EXECUTOR',
        retryable: false,
        safeMessage: '未找到',
      },
      diagnostics: {
        outcome: 'NOT_FOUND',
        candidatesTried: [{ index: 0, by: 'css', value: '#gone', matches: 0 }],
      },
      screenshot: { missingReason: 'capture_failed' },
      stepRunStatus: 'FAILED',
      runStatus: 'FAILED',
      skipRemaining: true,
      grant,
    })
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    expect(evidence.items.some((item) => item.type === 'error')).toBe(true)
    expect(evidence.items.find((item) => item.type === 'log')?.payload).toEqual({
      outcome: 'NOT_FOUND',
      candidatesTried: [{ index: 0, by: 'css', value: '#gone', matches: 0 }],
    })
    const shot = evidence.items.find((item) => item.type === 'screenshot')
    expect(shot?.missingReason).toBe('capture_failed')
    expect(shot?.objectKey).toBeUndefined()
    expect(shot?.payload).toBeUndefined()
  })

  it('finishAttempt 成功时保留执行器带出的定位诊断（AI 档救活的补丁提案）', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: 'AI 救活证据',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    const diagnostics = {
      outcome: 'FOUND' as const,
      candidatesTried: [],
      resolvedVia: 'ai' as const,
      suggestedCandidate: { by: 'testId' as const, value: 'search-btn' },
      suggestedPatch: { kind: 'ADD_CANDIDATE' as const, suggestedCandidate: { by: 'testId' as const, value: 'search-btn' } },
    }
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: {},
      diagnostics,
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
    })
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    expect(evidence.items.find((item) => item.type === 'log')?.payload).toEqual(diagnostics)
  })

  it('finishAttempt 把空 Trace 的 capture_failed 落成 missing 行', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '空 Trace',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'FAILED',
      error: {
        code: 'TARGET_NOT_FOUND',
        category: 'EXECUTOR',
        retryable: false,
        safeMessage: '未找到',
      },
      trace: { missingReason: 'capture_failed' },
      stepRunStatus: 'FAILED',
      runStatus: 'FAILED',
      skipRemaining: true,
      grant,
    })
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    const trace = evidence.items.find((item) => item.type === 'trace')
    expect(trace?.status).toBe('missing')
    expect(trace?.missingReason).toBe('capture_failed')
    expect(trace?.objectKey).toBeUndefined()
  })

  it('领取跳过已请求取消的 QUEUED Run', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '不领取',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    await handle.db.update(runs).set({ cancelRequestedAt: databaseNow(handle.db) }).where(eq(runs.status, 'QUEUED'))
    const worker = await seedWorker(handle)
    expect(await claimRun(handle, { workerId: worker.workerId, instanceId: worker.instanceId, leaseTtlSeconds: 30 })).toBeNull()
  })
})
