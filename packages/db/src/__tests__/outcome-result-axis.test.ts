import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  OUTCOME_MANIFEST_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  type AuthoringNode,
  type OutcomeContract,
  type OutcomeManifest,
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
  })
})
