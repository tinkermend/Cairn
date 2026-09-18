import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  OUTCOME_MANIFEST_PROTOCOL,
  RUNTIME_INVARIANT_MANIFEST_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  computeContextVersion,
  createRuntimeInvariant,
  type AuthCheckpoint,
  type AuthoringNode,
  type OutcomeContract,
  type OutcomeManifest,
  type RuntimeInvariant,
  type RunSnapshot,
  type Step,
} from '@cairn/shared'
import {
  backfillOutcomeResults,
  claimRun,
  computeSnapshotDigest,
  createRunWithSnapshot,
  createScenarioWithVersion,
  failRunValidation,
  finishAttempt,
  finishRunIfDrained,
  listRuns,
  loadRunDetail,
  markRunCancelled,
  openIsolatedDb,
  publishScenarioDraft,
  registerWorker as registerWorkerRaw,
  reviewRun,
  saveScenarioDraft,
  schemaFor,
  startAttempt,
  settleRunOutcome,
  markRunWaitingForAuth,
  writeRunAuthCheckpoint,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
import { runs as pg_runs, stepRuns as pg_stepRuns, outcomeResults as pg_outcomeResults } from '../schema/execution.js'
import { targets as pg_targets } from '../schema/targets.js'
import { forceGrantForRun, seedWorker } from './lease-harness.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_outcome`

const registerWorkerWith = (db: any, input: any) =>
  registerWorkerRaw(db, {
    ...input,
    protocolCapabilities: [
      SESSION_OCCUPANCY_PROTOCOL,
      ...(input.protocolCapabilities ?? []),
    ],
  })

const step1Id = '00000000-0000-4000-8000-000000000091'
const step2Id = '00000000-0000-4000-8000-000000000092'
const contractMustId = '00000000-0000-4000-8000-000000000081'
const contractShouldId = '00000000-0000-4000-8000-000000000082'

const echoStep: Step = {
  id: step1Id,
  name: '回显 1',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'echo_1',
  input: { value: 'val1' },
}

const assertStep: Step = {
  id: step2Id,
  name: '断言 2',
  type: 'assert',
  effectType: 'READ_ONLY',
  input: {
    expect: { kind: 'text_equals', value: 'expected_val' },
  },
}

describe('Outcome 结果轴与契约底座（集成）', () => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let consoleAccounts: typeof pg_consoleAccounts
  let runs: typeof pg_runs
  let stepRuns: typeof pg_stepRuns
  let outcomeResults: typeof pg_outcomeResults
  let targets: typeof pg_targets

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    ;({ consoleAccounts, runs, stepRuns, outcomeResults, targets } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'outcome-tester',
      email: `outcome-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `outcome-${SCHEMA.slice(-6)}`,
      name: '结果轴测试目标',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function createScenarioWithNodes(input: {
    name: string
    nodes: AuthoringNode[]
    scenarioOutcomes?: OutcomeContract[]
    runtimeInvariants?: RuntimeInvariant[]
  }) {
    // 初始版本放一个临时步骤，确保草稿发布时 sourceDocumentDigest 发生变化，从而成功落库 version 2
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: input.name,
      steps: [{ ...echoStep, id: newId() }],
      actor: { id: actorId },
    })

    const doc = {
      authoringSchemaVersion: 2 as const,
      nodes: input.nodes,
      scenarioOutcomes: input.scenarioOutcomes,
      runtimeInvariants: input.runtimeInvariants,
    }

    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: doc,
      actor: { id: actorId },
    })

    await publishScenarioDraft(handle.db, scenario.id, {
      revision: 2,
      actor: { id: actorId },
    })

    return scenario
  }

  it('OCA-13: Snapshot Digest 零漂移（无 outcomeManifest 时 digest 完全不变）', () => {
    const baseSnapshot: RunSnapshot = {
      schemaVersion: 1,
      runId: newId(),
      targetId,
      scenarioId: newId(),
      scenarioVersionId: newId(),
      steps: [echoStep, assertStep],
      allowedOrigins: ['https://example.com'],
      executionPolicy: { timeoutMs: 30000, retryLimit: 1 },
      createdAt: new Date('2026-09-17T00:00:00.000Z'),
      digest: '',
    }
    const digestWithout = computeSnapshotDigest(baseSnapshot)
    expect(digestWithout).toHaveLength(64)

    // 追加 outcomeManifest 后产生新 digest
    const snapshotWith: RunSnapshot = {
      ...baseSnapshot,
      outcomeManifest: {
        entries: [
          {
            contractId: contractMustId,
            scope: 'step',
            meaning: '核心断言必须成立',
            severity: 'MUST',
            onViolation: 'continue',
            provenance: 'manual',
            stepId: step2Id,
            rule: { kind: 'deterministic', expect: { kind: 'text_equals', value: 'expected_val' } },
          },
        ],
      },
    }
    const digestWith = computeSnapshotDigest(snapshotWith)
    expect(digestWith).toHaveLength(64)
    expect(digestWith).not.toBe(digestWithout)

    // 再次计算无 outcomeManifest 的对象，与之前完全一致
    expect(computeSnapshotDigest(baseSnapshot)).toBe(digestWithout)

    const snapshotInvariant: RunSnapshot = {
      ...baseSnapshot,
      runtimeInvariantManifest: {
        entries: [createRuntimeInvariant('navigation_boundary', contractMustId)],
      },
    }
    expect(computeSnapshotDigest(snapshotInvariant)).not.toBe(digestWithout)
  })

  it('调度排他：未声明 snapshot.outcomeManifest@1 的 Worker 跳过含契约清单的 Run', async () => {
    const scenario = await createScenarioWithNodes({
      name: '结果轴调度测试',
      nodes: [
        { kind: 'step', step: echoStep },
        {
          kind: 'step',
          step: assertStep,
          outcomes: [
            {
              id: contractMustId,
              scope: 'step',
              meaning: '核心断言必须成立',
              severity: 'MUST',
              onViolation: 'continue',
              provenance: 'manual',
              rule: { kind: 'deterministic', expect: { kind: 'text_equals', value: 'expected_val' } },
            },
          ],
        },
      ],
    })

    const runCreated = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const runId = runCreated.detail.id
    expect(runCreated.detail.snapshot.outcomeManifest).toBeDefined()
    expect(runCreated.detail.snapshot.outcomeManifest?.entries).toHaveLength(1)

    // Worker 1: 未声明 OUTCOME_MANIFEST_PROTOCOL
    const workerLegacy = await seedWorker(handle, `worker-legacy-${newId()}`)
    const grantLegacy = await claimRun(handle, {
      workerId: workerLegacy.workerId,
      instanceId: workerLegacy.instanceId,
      leaseTtlSeconds: 30,
    })
    expect(grantLegacy).toBeNull()

    // Worker 2: 声明了 OUTCOME_MANIFEST_PROTOCOL
    const workerOutcome = { workerId: `worker-oc-${newId()}`, instanceId: newId() }
    await registerWorkerWith(handle.db, {
      workerId: workerOutcome.workerId,
      instanceId: workerOutcome.instanceId,
      capacity: 8,
      protocolCapabilities: [OUTCOME_MANIFEST_PROTOCOL],
      lostAfterSeconds: 60,
    })
    const grantOutcome = await claimRun(handle, {
      workerId: workerOutcome.workerId,
      instanceId: workerOutcome.instanceId,
      leaseTtlSeconds: 30,
    })
    expect(grantOutcome).not.toBeNull()
    expect(grantOutcome!.runId).toBe(runId)
  })

  it('终态路径 1: finishAttempt 同事务保存 outcomeResults 并聚合 runs.outcomeStatus', async () => {
    const scenario = await createScenarioWithNodes({
      name: 'finishAttempt 终态测试',
      nodes: [
        { kind: 'step', step: echoStep },
        {
          kind: 'step',
          step: assertStep,
          outcomes: [
            {
              id: contractMustId,
              scope: 'step',
              meaning: '核心断言必须成立',
              severity: 'MUST',
              onViolation: 'continue',
              provenance: 'manual',
              rule: { kind: 'deterministic', expect: { kind: 'text_equals', value: 'expected_val' } },
            },
          ],
        },
      ],
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const runId = run.detail.id

    const grant = await forceGrantForRun(handle, runId, 'tester-w1')
    const start1 = await startAttempt(handle.db, {
      runId,
      stepRunId: run.detail.stepRuns[0]!.id,
      grant,
      inputPayload: { value: 'val1' },
    })
    expect(start1).not.toBeNull()

    // 第一步完成（非断言步骤，无结果轴项）
    await finishAttempt(handle.db, {
      runId,
      attemptId: start1!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { ok: true },
      stepRunStatus: 'SUCCEEDED',
      grant,
    })

    // 第二步开始并完成，附带 OutcomeResult (PASS)
    const start2 = await startAttempt(handle.db, {
      runId,
      stepRunId: run.detail.stepRuns[1]!.id,
      grant,
      inputPayload: {},
    })
    expect(start2).not.toBeNull()

    const finishResult = await finishAttempt(handle.db, {
      runId,
      attemptId: start2!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { passed: true },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
      outcomeResults: [
        {
          contractId: contractMustId,
          scope: 'step',
          meaning: '核心断言必须成立',
          severity: 'MUST',
          onViolation: 'continue',
          provenance: 'manual',
          verdict: 'PASS',
          expected: 'expected_val',
          actual: 'expected_val',
          evaluatedAt: new Date(),
        },
      ],
    })
    expect(finishResult.updated).toBe(true)

    // 验证 Run 级与 StepRun 级 outcomeStatus
    const detail = await loadRunDetail(handle.db, runId)
    expect(detail?.status).toBe('SUCCEEDED')
    expect(detail?.outcomeStatus).toBe('PASS')
    expect(detail?.stepRuns[1]!.outcomeStatus).toBe('PASS')
    expect(detail?.outcomeResults).toHaveLength(1)
    expect(detail?.outcomeResults[0]!.verdict).toBe('PASS')
    expect(detail?.outcomeResults[0]!.evidenceId).toBeTruthy()
  })

  it('finishAttempt 结果行优先挂 Attempt 截图 evidenceId', async () => {
    const scenario = await createScenarioWithNodes({
      name: '结果行挂截图',
      nodes: [
        {
          kind: 'step',
          step: assertStep,
          outcomes: [
            {
              id: contractMustId,
              scope: 'step',
              meaning: '核心断言必须成立',
              severity: 'MUST',
              onViolation: 'continue',
              provenance: 'manual',
              rule: { kind: 'deterministic', expect: { kind: 'text_equals', value: 'expected_val' } },
            },
          ],
        },
      ],
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, run.detail.id, 'tester-w-evidence')
    const start = await startAttempt(handle.db, {
      runId: run.detail.id,
      stepRunId: run.detail.stepRuns[0]!.id,
      grant,
      inputPayload: {},
    })
    await finishAttempt(handle.db, {
      runId: run.detail.id,
      attemptId: start!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { passed: true },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
      screenshot: { missingReason: 'capture_failed' },
      outcomeResults: [
        {
          contractId: contractMustId,
          scope: 'step',
          meaning: '核心断言必须成立',
          severity: 'MUST',
          onViolation: 'continue',
          provenance: 'manual',
          verdict: 'PASS',
          expected: 'expected_val',
          actual: 'expected_val',
          evaluatedAt: new Date(),
        },
      ],
    })
    const detail = await loadRunDetail(handle.db, run.detail.id)
    const { evidences } = schemaFor(handle.db)
    const shots = await handle.db
      .select({ id: evidences.id, type: evidences.type })
      .from(evidences)
      .where(eq(evidences.attemptId, start!.attemptId))
    const screenshot = shots.find((row) => row.type === 'screenshot')
    expect(screenshot).toBeTruthy()
    expect(detail?.outcomeResults[0]!.evidenceId).toBe(screenshot!.id)
  })

  it('终态路径 1 (WARN): SHOULD 条件不满足时 Run 状态为 SUCCEEDED 但 outcomeStatus 为 WARN', async () => {
    const scenario = await createScenarioWithNodes({
      name: 'SHOULD 条件失败测试',
      nodes: [
        {
          kind: 'step',
          step: assertStep,
          outcomes: [
            {
              id: contractShouldId,
              scope: 'step',
              meaning: '提示性断言',
              severity: 'SHOULD',
              onViolation: 'continue',
              provenance: 'manual',
              rule: { kind: 'deterministic', expect: { kind: 'text_equals', value: 'expected_val' } },
            },
          ],
        },
      ],
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const runId = run.detail.id

    const grant = await forceGrantForRun(handle, runId, 'tester-w2')
    const start = await startAttempt(handle.db, {
      runId,
      stepRunId: run.detail.stepRuns[0]!.id,
      grant,
      inputPayload: {},
    })

    await finishAttempt(handle.db, {
      runId,
      attemptId: start!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { passed: false },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
      outcomeResults: [
        {
          contractId: contractShouldId,
          scope: 'step',
          meaning: '提示性断言',
          severity: 'SHOULD',
          onViolation: 'continue',
          provenance: 'manual',
          verdict: 'FAIL',
          expected: 'expected_val',
          actual: 'wrong_val',
          evaluatedAt: new Date(),
        },
      ],
    })

    const detail = await loadRunDetail(handle.db, runId)
    expect(detail?.status).toBe('SUCCEEDED')
    expect(detail?.outcomeStatus).toBe('WARN')
    expect(detail?.stepRuns[0]!.outcomeStatus).toBe('WARN')
    expect(detail?.outcomeResults[0]!.verdict).toBe('FAIL')
  })

  it('终态路径 2: finishRunIfDrained 补算并更新 runs.outcomeStatus', async () => {
    const scenario = await createScenarioWithNodes({
      name: 'finishRunIfDrained 测试',
      nodes: [
        {
          kind: 'step',
          step: assertStep,
          outcomes: [
            {
              id: contractMustId,
              scope: 'step',
              meaning: '核心断言必须成立',
              severity: 'MUST',
              onViolation: 'continue',
              provenance: 'manual',
              rule: { kind: 'deterministic', expect: { kind: 'text_equals', value: 'expected_val' } },
            },
          ],
        },
      ],
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const runId = run.detail.id

    const grant = await forceGrantForRun(handle, runId, 'tester-w3')
    const start = await startAttempt(handle.db, {
      runId,
      stepRunId: run.detail.stepRuns[0]!.id,
      grant,
      inputPayload: {},
    })

    // finishAttempt 不传 runStatus，使 Run 仍为 RUNNING
    await finishAttempt(handle.db, {
      runId,
      attemptId: start!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { passed: true },
      stepRunStatus: 'SUCCEEDED',
      grant,
      outcomeResults: [
        {
          contractId: contractMustId,
          scope: 'step',
          meaning: '核心断言必须成立',
          severity: 'MUST',
          onViolation: 'continue',
          provenance: 'manual',
          verdict: 'PASS',
          evaluatedAt: new Date(),
        },
      ],
    })

    // finishRunIfDrained 收口
    const drained = await finishRunIfDrained(handle.db, grant)
    expect(drained.finished).toBe(true)

    const detail = await loadRunDetail(handle.db, runId)
    expect(detail?.status).toBe('SUCCEEDED')
    expect(detail?.outcomeStatus).toBe('PASS')
  })

  it('终态路径 3: markRunCancelled 用户主动取消有未求值 MUST 时判 UNKNOWN', async () => {
    const scenario = await createScenarioWithNodes({
      name: '取消测试',
      nodes: [
        { kind: 'step', step: echoStep },
        {
          kind: 'step',
          step: assertStep,
          outcomes: [
            {
              id: contractMustId,
              scope: 'step',
              meaning: '核心断言必须成立',
              severity: 'MUST',
              onViolation: 'continue',
              provenance: 'manual',
              rule: { kind: 'deterministic', expect: { kind: 'text_equals', value: 'expected_val' } },
            },
          ],
        },
      ],
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const runId = run.detail.id

    const grant = await forceGrantForRun(handle, runId, 'tester-w4')
    await markRunCancelled(handle.db, runId, { grant })

    const detail = await loadRunDetail(handle.db, runId)
    expect(detail?.status).toBe('CANCELLED')
    expect(detail?.outcomeStatus).toBe('UNKNOWN')
  })

  it('终态路径 4: failRunValidation 配置前置失败时判 UNKNOWN', async () => {
    const scenario = await createScenarioWithNodes({
      name: '校验失败测试',
      nodes: [
        { kind: 'step', step: echoStep },
        {
          kind: 'step',
          step: assertStep,
          outcomes: [
            {
              id: contractMustId,
              scope: 'step',
              meaning: '核心断言必须成立',
              severity: 'MUST',
              onViolation: 'continue',
              provenance: 'manual',
              rule: { kind: 'deterministic', expect: { kind: 'text_equals', value: 'expected_val' } },
            },
          ],
        },
      ],
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const runId = run.detail.id

    const grant = await forceGrantForRun(handle, runId, 'tester-w5')
    await failRunValidation(handle.db, runId, { grant })

    const detail = await loadRunDetail(handle.db, runId)
    expect(detail?.status).toBe('FAILED')
    expect(detail?.outcomeStatus).toBe('UNKNOWN')
  })

  it('终态路径 5: reviewRun 人工核查后重算结果轴', async () => {
    const scenario = await createScenarioWithNodes({
      name: '核查测试',
      nodes: [
        { kind: 'step', step: echoStep },
        {
          kind: 'step',
          step: assertStep,
          outcomes: [
            {
              id: contractMustId,
              scope: 'step',
              meaning: '核心断言必须成立',
              severity: 'MUST',
              onViolation: 'continue',
              provenance: 'manual',
              rule: { kind: 'deterministic', expect: { kind: 'text_equals', value: 'expected_val' } },
            },
          ],
        },
      ],
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const runId = run.detail.id

    const grant = await forceGrantForRun(handle, runId, 'tester-w6')
    const start = await startAttempt(handle.db, {
      runId,
      stepRunId: run.detail.stepRuns[0]!.id,
      grant,
      inputPayload: {},
    })

    // 通过 finishAttempt 迁入 NEEDS_REVIEW
    await finishAttempt(handle.db, {
      runId,
      attemptId: start!.attemptId,
      attemptStatus: 'FAILED',
      error: { code: 'UNKNOWN', category: 'UNKNOWN', retryable: false, safeMessage: '需人工核查' },
      stepRunStatus: 'FAILED',
      runStatus: 'NEEDS_REVIEW',
      grant,
    })

    await reviewRun(handle.db, {
      runId,
      actor: { id: actorId },
      conclusion: 'fail',
      note: '人工判定失败',
    })

    const detail = await loadRunDetail(handle.db, runId)
    expect(detail?.status).toBe('FAILED')
    expect(detail?.outcomeStatus).toBe('UNKNOWN') // MUST 未求值
  })

  it('查询与过滤：listRuns 支持 outcomeStatus 过滤', async () => {
    const listPass = await listRuns(handle.db, { outcomeStatus: 'PASS' })
    expect(listPass.items.every((r) => r.outcomeStatus === 'PASS')).toBe(true)
    expect(listPass.items.length).toBeGreaterThan(0)

    const listWarn = await listRuns(handle.db, { outcomeStatus: 'WARN' })
    expect(listWarn.items.every((r) => r.outcomeStatus === 'WARN')).toBe(true)
    expect(listWarn.items.length).toBeGreaterThan(0)
  })

  it('补算任务：backfillOutcomeResults 扫描并修复 outcome_status', async () => {
    // 选一个终态 Run，强制将其 outcome_status 置为 NOT_EVALUATED
    const listPass = await listRuns(handle.db, { outcomeStatus: 'PASS' })
    const targetRun = listPass.items[0]!
    await handle.db
      .update(runs)
      .set({ outcomeStatus: 'NOT_EVALUATED' })
      .where(eq(runs.id, targetRun.id))

    // 运行补算
    const backfillResult = await backfillOutcomeResults(handle.db)
    expect(backfillResult.scanned).toBeGreaterThan(0)
    expect(backfillResult.updated).toBeGreaterThan(0)

    // 验证已被修复回 PASS
    const detail = await loadRunDetail(handle.db, targetRun.id)
    expect(detail?.outcomeStatus).toBe('PASS')

    const deletedId = targetRun.id
    await handle.db
      .update(runs)
      .set({
        outcomeStatus: 'NOT_EVALUATED',
        deletedAt: new Date(),
        deletedBy: { id: actorId, displayName: 'outcome-tester', kind: 'console' },
      })
      .where(eq(runs.id, deletedId))
    await backfillOutcomeResults(handle.db, { limit: 20 })
    expect(await loadRunDetail(handle.db, deletedId)).toBeNull()
    const [deletedRow] = await handle.db
      .select({ outcomeStatus: runs.outcomeStatus })
      .from(runs)
      .where(eq(runs.id, deletedId))
    expect(deletedRow?.outcomeStatus).toBe('NOT_EVALUATED')
  })

  it('OCC：含 runtimeInvariantManifest 的 Run 要求新协议，收尾写 PASS', async () => {
    const invariantId = '00000000-0000-4000-8000-000000000083'
    const scenario = await createScenarioWithNodes({
      name: '运行期约束协议',
      nodes: [{ kind: 'step', step: echoStep }],
      runtimeInvariants: [createRuntimeInvariant('readonly_guarantee', invariantId)],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.runtimeInvariantManifest?.entries).toHaveLength(1)

    const legacy = await seedWorker(handle, `worker-inv-legacy-${newId()}`)
    const leftover = await claimRun(handle, {
      workerId: legacy.workerId,
      instanceId: legacy.instanceId,
      leaseTtlSeconds: 30,
    })
    expect(leftover?.runId ?? null).not.toBe(created.detail.id)

    const grant = await forceGrantForRun(handle, created.detail.id, `worker-inv-${newId()}`)

    const start = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      grant: grant!,
      inputPayload: { value: 'val1' },
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: start!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { echoed: 'ok' },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant: grant!,
    })
    await settleRunOutcome(handle, created.detail.id)
    const detail = await loadRunDetail(handle.db, created.detail.id)
    expect(detail?.outcomeStatus).toBe('PASS')
    expect(detail?.outcomeResults.some((row) => row.contractId === invariantId && row.verdict === 'PASS')).toBe(
      true,
    )
  })

  function authCheckpointFor(run: { snapshot: { steps: { id: string }[] } }, extra: Partial<AuthCheckpoint> = {}): AuthCheckpoint {
    return {
      schemaVersion: 1,
      status: 'closed',
      closedAt: '2026-09-17T04:00:00.000Z',
      trigger: { kind: 'navigated_to_login', at: '2026-09-17T04:00:00.000Z', summary: '/login' },
      nextStepId: run.snapshot.steps[0]!.id,
      nextOrdinal: 0,
      interruptedClassification: 'not_dispatched',
      contextVersion: 'a'.repeat(64),
      contextKeys: [],
      sessionGeneration: 1,
      fencingToken: '1',
      recoveryRule: {
        reuse: 'NEW_PAGE',
        entryUrl: 'https://example.com/',
        allowedOrigins: ['https://example.com'],
      },
      capability: 'IDENTITY_VERIFIED',
      autoRecoveriesUsed: 0,
      manualRecoveriesUsed: 0,
      ...extra,
    }
  }

  it('OCC-02：越界导航错误码不变，同时写 navigation_boundary FAIL', async () => {
    const invariantId = '00000000-0000-4000-8000-000000000084'
    const scenario = await createScenarioWithNodes({
      name: '越界导航约束',
      nodes: [{ kind: 'step', step: echoStep }],
      runtimeInvariants: [createRuntimeInvariant('navigation_boundary', invariantId)],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, created.detail.id, `worker-nav-${newId()}`)
    const start = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      grant: grant!,
      inputPayload: { value: 'val1' },
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: start!.attemptId,
      attemptStatus: 'FAILED',
      error: {
        code: 'NAVIGATE_OUT_OF_SCOPE',
        category: 'VALIDATION',
        retryable: false,
        safeMessage: '导航离开允许范围',
      },
      stepRunStatus: 'FAILED',
      runStatus: 'FAILED',
      grant: grant!,
    })
    const detail = await loadRunDetail(handle.db, created.detail.id)
    expect(detail?.status).toBe('FAILED')
    expect(detail?.stepRuns[0]?.attempts[0]?.error).toMatchObject({ code: 'NAVIGATE_OUT_OF_SCOPE' })
    expect(detail?.outcomeStatus).toBe('FAIL')
    const row = detail?.outcomeResults.find((item) => item.contractId === invariantId)
    expect(row).toMatchObject({
      provenance: 'runtime_invariant',
      verdict: 'FAIL',
      actual: { errorCode: 'NAVIGATE_OUT_OF_SCOPE' },
    })
  })

  it('OCC-03：恢复成功仍保留 auth_validity FAIL，结果轴 WARN，检查点写入即记账', async () => {
    const invariantId = '00000000-0000-4000-8000-000000000085'
    const scenario = await createScenarioWithNodes({
      name: '认证约束',
      nodes: [{ kind: 'step', step: echoStep }],
      runtimeInvariants: [createRuntimeInvariant('auth_validity', invariantId)],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, created.detail.id, `worker-auth-${newId()}`)
    const start = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      grant: grant!,
      inputPayload: { value: 'val1' },
    })
    const closed = authCheckpointFor(created.detail, {
      interruptedAttemptId: start!.attemptId,
      fencingToken: String(grant!.fencingToken),
      contextVersion: await computeContextVersion(created.detail.context),
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: start!.attemptId,
      attemptStatus: 'FAILED',
      error: {
        code: 'AUTH_GATE_CLOSED',
        category: 'INFRASTRUCTURE',
        retryable: false,
        safeMessage: '登录已失效',
      },
      stepRunStatus: 'RUNNING',
      authCheckpoint: closed,
      grant: grant!,
    })
    const written = await writeRunAuthCheckpoint(handle.db, {
      runId: created.detail.id,
      grant: grant!,
      checkpoint: { ...closed, status: 'recovering', recoveryKind: 'auto', autoRecoveriesUsed: 1 },
    })
    expect(written).toBe(true)
    const holding = await loadRunDetail(handle.db, created.detail.id)
    expect(holding?.status).toBe('RUNNING')
    expect(holding?.authCheckpoint?.status).toBe('recovering')
    expect(holding?.outcomeStatus).toBe('WARN')
    expect(holding?.outcomeResults.some((row) => row.contractId === invariantId && row.verdict === 'FAIL')).toBe(true)

    await writeRunAuthCheckpoint(handle.db, {
      runId: created.detail.id,
      grant: grant!,
      checkpoint: { ...closed, status: 'recovered', recoveryKind: 'auto', autoRecoveriesUsed: 1 },
    })
    const recovered = await loadRunDetail(handle.db, created.detail.id)
    expect(recovered?.authCheckpoint?.status).toBe('recovered')
    expect(recovered?.outcomeStatus).toBe('WARN')
    expect(recovered?.outcomeResults.filter((row) => row.contractId === invariantId && row.verdict === 'FAIL')).toHaveLength(1)
  })

  it('OCC-03：开跑前 WAITING_FOR_AUTH 补首步窗口并记 SHOULD FAIL / WARN', async () => {
    const invariantId = '00000000-0000-4000-8000-00000000008a'
    const scenario = await createScenarioWithNodes({
      name: '开跑前认证约束',
      nodes: [{ kind: 'step', step: echoStep }],
      runtimeInvariants: [createRuntimeInvariant('auth_validity', invariantId)],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, created.detail.id, `worker-auth-pre-${newId()}`)
    expect(created.detail.stepRuns[0]?.attempts ?? []).toHaveLength(0)
    expect(await markRunWaitingForAuth(handle.db, grant!)).toBe(true)
    const detail = await loadRunDetail(handle.db, created.detail.id)
    expect(detail?.status).toBe('WAITING_FOR_AUTH')
    expect(detail?.stepRuns[0]?.status).toBe('RUNNING')
    expect(detail?.stepRuns[0]?.attempts[0]?.error).toMatchObject({ code: 'AUTH_GATE_CLOSED' })
    expect(detail?.outcomeStatus).toBe('WARN')
    expect(detail?.outcomeResults.some((row) => row.contractId === invariantId && row.verdict === 'FAIL')).toBe(
      true,
    )
  })

  it('OCC-04：只读约束对照 SIDE_EFFECT 记 FAIL，不要求写拦截', async () => {
    const invariantId = '00000000-0000-4000-8000-000000000086'
    const clickId = '00000000-0000-4000-8000-000000000093'
    const clickStep: Step = {
      id: clickId,
      name: '点击',
      type: 'click',
      effectType: 'SIDE_EFFECT',
      input: { target: { framePath: [], candidates: [{ by: 'css', value: 'button' }] } },
    }
    const scenario = await createScenarioWithNodes({
      name: '只读约束',
      nodes: [{ kind: 'step', step: clickStep }],
      runtimeInvariants: [createRuntimeInvariant('readonly_guarantee', invariantId)],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, created.detail.id, `worker-ro-${newId()}`)
    const start = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      grant: grant!,
      inputPayload: {},
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: start!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { clicked: true },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant: grant!,
    })
    const detail = await loadRunDetail(handle.db, created.detail.id)
    expect(detail?.status).toBe('SUCCEEDED')
    expect(detail?.outcomeStatus).toBe('FAIL')
    expect(detail?.outcomeResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contractId: invariantId,
          verdict: 'FAIL',
          actual: expect.objectContaining({ effectType: 'SIDE_EFFECT' }),
        }),
      ]),
    )
  })

  it('OCC-05：页面探测命中写 FAIL 并脱敏；CHECK 拒绝未知 provenance', async () => {
    const invariantId = '00000000-0000-4000-8000-000000000087'
    const scenario = await createScenarioWithNodes({
      name: '错误弹窗约束',
      nodes: [{ kind: 'step', step: echoStep }],
      runtimeInvariants: [createRuntimeInvariant('error_surface', invariantId)],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, created.detail.id, `worker-surf-${newId()}`)
    const start = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      grant: grant!,
      inputPayload: { value: 'val1' },
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: start!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: {
        echoed: 'ok',
        errorSurface: {
          probed: true,
          matches: [{ role: 'alertdialog', text: 'password=hunter2 系统异常 user@example.com' }],
        },
      },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant: grant!,
    })
    const detail = await loadRunDetail(handle.db, created.detail.id)
    expect(detail?.status).toBe('SUCCEEDED')
    expect(detail?.outcomeStatus).toBe('FAIL')
    const row = detail?.outcomeResults.find((item) => item.contractId === invariantId)
    expect(row?.verdict).toBe('FAIL')
    expect(row?.evidenceId).toBeTruthy()
    expect(JSON.stringify(row?.actual)).toMatch(/password=\*\*\*/)
    expect(JSON.stringify(row?.actual)).toMatch(/\[redacted-email\]/)
    expect(JSON.stringify(row?.actual)).not.toMatch(/hunter2/)

    await expect(
      handle.db.insert(outcomeResults).values({
        id: newId(),
        runId: created.detail.id,
        stepRunId: created.detail.stepRuns[0]!.id,
        attemptId: start!.attemptId,
        contractId: '00000000-0000-4000-8000-000000000088',
        scope: 'scenario',
        meaning: '非法来源',
        severity: 'MUST',
        onViolation: 'continue',
        provenance: 'not_a_source' as never,
        verdict: 'PASS',
        evaluatedAt: new Date(),
        createdAt: new Date(),
      }),
    ).rejects.toSatisfy((error: Error) =>
      String(error.cause ?? error).match(/outcome_results_provenance_check|23514|CHECK/i) !== null,
    )
  })
})
