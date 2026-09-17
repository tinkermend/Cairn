import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  claimRun,
  claimSessionUse,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  loadRunDetail,
  newId,
  openIsolatedDb,
  publishScenarioDraft,
  registerWorker,
  releaseSessionUse,
  requireCreatedSession,
  saveScenarioDraft,
  setSessionProbe,
  setSessionStatus,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import {
  type AuthoringNode,
  type OutcomeContract,
  type RuntimeInvariant,
  type RunSnapshot,
  type SessionGrant,
  type Step,
} from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { ExecutionEngine } from './engine.js'
import { collectAttemptOutcomeResults } from './outcome-collector.js'
import type { ExecutorOutcome } from './engine-types.js'
import type { BrowserCommandResult, BrowserPort } from './ports.js'

describe('collectAttemptOutcomeResults 单元逻辑', () => {
  const stepId = '00000000-0000-4000-8000-000000000001'
  const contractId = '00000000-0000-4000-8000-000000000011'
  const attemptId = '00000000-0000-4000-8000-000000000021'
  const now = new Date('2026-09-17T12:00:00.000Z')

  const baseStep: Step = {
    id: stepId,
    name: '测试断言',
    type: 'assert',
    effectType: 'READ_ONLY',
    input: {
      expect: { kind: 'text_equals', value: 'expected_text' },
    },
  }

  function makeSnapshot(
    onViolation: 'halt' | 'continue' = 'halt',
    severity: 'MUST' | 'SHOULD' = 'MUST',
  ): RunSnapshot {
    return {
      schemaVersion: 1,
      runId: newId(),
      targetId: newId(),
      scenarioId: newId(),
      scenarioVersionId: newId(),
      steps: [baseStep],
      allowedOrigins: ['https://example.com'],
      executionPolicy: { timeoutMs: 30000, retryLimit: 1 },
      createdAt: now,
      digest: 'a'.repeat(64),
      outcomeManifest: {
        entries: [
          {
            contractId,
            stepId,
            scope: 'step',
            meaning: '检查文本一致',
            severity,
            onViolation,
            provenance: 'manual',
            rule: {
              kind: 'deterministic',
              expect: { kind: 'text_equals', value: 'expected_text' },
            },
          },
        ],
      },
    }
  }

  it('成功完成 -> verdict: PASS, continueMode: false', () => {
    const outcome: ExecutorOutcome = {
      kind: 'success',
      output: { actual: 'expected_text', passed: true },
    }
    const res = collectAttemptOutcomeResults({
      snapshot: makeSnapshot(),
      step: baseStep,
      outcome,
      attemptId,
      now,
    })
    expect(res.continueMode).toBe(false)
    expect(res.outcomeResults).toHaveLength(1)
    expect(res.outcomeResults[0]).toMatchObject({
      contractId,
      verdict: 'PASS',
      expected: { kind: 'text_equals', value: 'expected_text' },
      actual: 'expected_text',
    })
  })

  it('断言失败 + onViolation: continue -> verdict: FAIL, continueMode: true', () => {
    const outcome: ExecutorOutcome = {
      kind: 'failed',
      error: {
        code: 'ASSERT_FAILED',
        category: 'EXECUTOR',
        retryable: false,
        safeMessage: '文本不一致',
      },
      output: { actual: 'mismatched_text', passed: false },
      timedOut: false,
      aborted: false,
    }
    const res = collectAttemptOutcomeResults({
      snapshot: makeSnapshot('continue'),
      step: baseStep,
      outcome,
      attemptId,
      now,
    })
    expect(res.continueMode).toBe(true)
    expect(res.outcomeResults).toHaveLength(1)
    expect(res.outcomeResults[0]).toMatchObject({
      contractId,
      verdict: 'FAIL',
      onViolation: 'continue',
      actual: 'mismatched_text',
    })
  })

  it('断言失败 + onViolation: halt -> verdict: FAIL, continueMode: false', () => {
    const outcome: ExecutorOutcome = {
      kind: 'failed',
      error: {
        code: 'ASSERT_FAILED',
        category: 'EXECUTOR',
        retryable: false,
        safeMessage: '文本不一致',
      },
      output: { actual: 'mismatched_text', passed: false },
      timedOut: false,
      aborted: false,
    }
    const res = collectAttemptOutcomeResults({
      snapshot: makeSnapshot('halt'),
      step: baseStep,
      outcome,
      attemptId,
      now,
    })
    expect(res.continueMode).toBe(false)
    expect(res.outcomeResults).toHaveLength(1)
    expect(res.outcomeResults[0]).toMatchObject({
      contractId,
      verdict: 'FAIL',
      onViolation: 'halt',
    })
  })

  it('定位或基础设施失败（TARGET_NOT_FOUND）-> verdict: UNKNOWN, continueMode: false', () => {
    const outcome: ExecutorOutcome = {
      kind: 'failed',
      error: {
        code: 'TARGET_NOT_FOUND',
        category: 'INFRASTRUCTURE',
        retryable: false,
        safeMessage: '元素未找到',
      },
      timedOut: false,
      aborted: false,
    }
    // 即使契约配置了 onViolation: 'continue'，基础设施错误绝不转成功！
    const res = collectAttemptOutcomeResults({
      snapshot: makeSnapshot('continue'),
      step: baseStep,
      outcome,
      attemptId,
      now,
    })
    expect(res.continueMode).toBe(false)
    expect(res.outcomeResults).toHaveLength(1)
    expect(res.outcomeResults[0]).toMatchObject({
      contractId,
      verdict: 'UNKNOWN',
      actual: null,
      details: { code: 'TARGET_NOT_FOUND', safeMessage: '元素未找到' },
    })
  })

  it('无匹配 OutcomeContract 的步骤 -> outcomeResults 为空, continueMode: false', () => {
    const outcome: ExecutorOutcome = {
      kind: 'success',
      output: { ok: true },
    }
    const res = collectAttemptOutcomeResults({
      snapshot: makeSnapshot(),
      step: { ...baseStep, id: newId() },
      outcome,
      attemptId,
      now,
    })
    expect(res.continueMode).toBe(false)
    expect(res.outcomeResults).toHaveLength(0)
  })
})

const SCHEMA = `cairn_test_${Date.now().toString(36)}_engoutcome`

describe('ExecutionEngine 结果轴与巡检集成', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let engine: ExecutionEngine
  let actorId: string
  let targetId: string
  let workerId: string
  let workerInstanceId: string
  let browserBehavior: 'pass' | 'fail_assertion' | 'fail_infra' = 'pass'
  let executeCalls = 0
  let surfaceMatches: { role: string; text: string }[] = []

  async function openLease(runId: string, fencingToken: number): Promise<SessionGrant> {
    const account = newId()
    await handle.db.insert(targetAccounts).values({
      id: account,
      targetId,
      displayName: `lease-${account}`,
      username: `u-${account}`,
      status: 'active',
    })
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: account },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: workerInstanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    await setSessionProbe(handle.db, {
      sessionId: session.id,
      ownerWorkerId: workerId,
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
    })
    const lease = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: account },
      owner: { kind: 'RUN', runId, runFencingToken: fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: workerInstanceId,
      leaseTtlSeconds: 60,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    if (!lease.ok) throw new Error(lease.message ?? lease.code)
    return {
      sessionId: session.id,
      leaseId: lease.grant.leaseId,
      generation: lease.grant.generation,
      sessionFencingToken: lease.grant.sessionFencingToken,
      expiresAt: lease.grant.expiresAt,
    }
  }

  const mockBrowser: BrowserPort = {
    async acquire(snapshot, grant) {
      const sessionGrant = await openLease(grant.runId, grant.fencingToken)
      return {
        ok: true,
        grant: sessionGrant,
      }
    },
    async release(grant) {
      await releaseSessionUse(handle.db, {
        sessionId: grant.sessionId,
        leaseId: grant.leaseId,
        holderWorkerId: workerId,
        holderInstanceId: workerInstanceId,
      }).catch(() => undefined)
    },
    async probeErrorSurface() {
      return surfaceMatches
    },
    async execute(): Promise<BrowserCommandResult> {
      executeCalls += 1
      if (browserBehavior === 'fail_assertion') {
        return {
          ok: false,
          error: {
            code: 'ASSERT_FAILED',
            category: 'EXECUTOR',
            retryable: false,
            safeMessage: '预期包含[告警]但实际无匹配',
          },
          output: { actual: '无告警', passed: false },
        }
      }
      if (browserBehavior === 'fail_infra') {
        return {
          ok: false,
          error: {
            code: 'TARGET_NOT_FOUND',
            category: 'INFRASTRUCTURE',
            retryable: false,
            safeMessage: '目标环境无法连接',
          },
        }
      }
      return {
        ok: true,
        output: { actual: '告警', passed: true },
      }
    },
  }

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    engine = new ExecutionEngine(handle, mockBrowser)
    actorId = newId()
    targetId = newId()

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'outcome-engine-tester',
      email: `eng-outcome-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `outcome-${SCHEMA.slice(-8)}`,
      name: '引擎结果轴夹具',
      entryUrl: 'https://example.com',
    })

    workerId = `engoutcome-${SCHEMA.slice(-8)}`
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

  beforeEach(() => {
    browserBehavior = 'pass'
    executeCalls = 0
    surfaceMatches = []
  })

  async function claimThis(runId: string) {
    await handle.pool.query(
      `UPDATE runs
          SET status = 'CANCELLED',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING')
          AND id <> $1`,
      [runId],
    )
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 30,
    })
    expect(grant?.runId).toBe(runId)
    return grant!
  }

  async function createScenarioWithNodes(input: {
    name: string
    nodes: AuthoringNode[]
    scenarioOutcomes?: OutcomeContract[]
    runtimeInvariants?: RuntimeInvariant[]
  }) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: input.name,
      steps: [{ id: newId(), name: 'init', type: 'echo', effectType: 'READ_ONLY', input: { value: 'init' } }],
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

  it('continue 模式巡检语义：断言不成立时 Step 成功推进后续步骤，Run 完结，outcomeStatus 记 FAIL', async () => {
    browserBehavior = 'fail_assertion'
    const contractId = newId()
    const step1Id = newId()
    const step2Id = newId()

    // 步骤 1：断言步骤，onViolation 为 continue
    const assertStep: Step = {
      id: step1Id,
      name: '检查标题（巡检）',
      type: 'assert',
      effectType: 'READ_ONLY',
      input: {
        expect: { kind: 'text_equals', value: '告警' },
      },
    }

    // 步骤 2：后续步骤
    const echoStep: Step = {
      id: step2Id,
      name: '后续回显步骤',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: 'continued_success' },
    }

    const contract: OutcomeContract = {
      id: contractId,
      scope: 'step',
      meaning: '页面须包含告警',
      severity: 'MUST',
      onViolation: 'continue',
      provenance: 'manual',
      rule: {
        kind: 'deterministic',
        expect: { kind: 'text_equals', value: '告警' },
      },
    }

    const scenario = await createScenarioWithNodes({
      name: 'continue 巡检场景',
      nodes: [
        { kind: 'step', step: assertStep, outcomes: [contract] },
        { kind: 'step', step: echoStep },
      ],
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })

    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })

    const run = await getRun(handle.db, created.detail.id)
    // 关键断言 1：因 continue 模式，整个 Run 顺利完成所有步骤，状态为 SUCCEEDED
    expect(run.status).toBe('SUCCEEDED')

    // 关键断言 2：两个步骤逻辑状态均为 SUCCEEDED
    expect(run.stepRuns).toHaveLength(2)
    const step1Run = run.stepRuns.find((s) => s.stepId === step1Id)
    const step2Run = run.stepRuns.find((s) => s.stepId === step2Id)
    expect(step1Run?.status).toBe('SUCCEEDED')
    expect(step2Run?.status).toBe('SUCCEEDED')

    // 关键断言 3：加载详情，Run 结果轴状态为 FAIL（因为 MUST 级契约未通过），并且存有对应 outcomeResults
    const detail = await loadRunDetail(handle.db, created.detail.id)
    expect(detail).toBeDefined()
    expect(detail!.outcomeStatus).toBe('FAIL')
    expect(detail!.outcomeResults).toHaveLength(1)
    expect(detail!.outcomeResults![0]).toMatchObject({
      contractId,
      verdict: 'FAIL',
      onViolation: 'continue',
      severity: 'MUST',
    })
  })

  it('halt 模式：断言不成立时步骤与 Run 均失败，并持久化 outcomeResults FAIL', async () => {
    browserBehavior = 'fail_assertion'
    const contractId = newId()
    const step1Id = newId()
    const step2Id = newId()

    const assertStep: Step = {
      id: step1Id,
      name: '检查前置条件（阻断）',
      type: 'assert',
      effectType: 'READ_ONLY',
      input: {
        expect: { kind: 'text_equals', value: 'ok' },
      },
    }

    const echoStep: Step = {
      id: step2Id,
      name: '后续步骤',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: 'should_not_run' },
    }

    const contract: OutcomeContract = {
      id: contractId,
      scope: 'step',
      meaning: '前置条件须成立',
      severity: 'MUST',
      onViolation: 'halt',
      provenance: 'manual',
      rule: {
        kind: 'deterministic',
        expect: { kind: 'text_equals', value: 'ok' },
      },
    }

    const scenario = await createScenarioWithNodes({
      name: 'halt 阻断场景',
      nodes: [
        { kind: 'step', step: assertStep, outcomes: [contract] },
        { kind: 'step', step: echoStep },
      ],
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })

    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })

    const run = await getRun(handle.db, created.detail.id)
    expect(run.status).toBe('FAILED')

    const detail = await loadRunDetail(handle.db, created.detail.id)
    expect(detail).toBeDefined()
    expect(detail!.outcomeStatus).toBe('FAIL')
    expect(detail!.outcomeResults).toHaveLength(1)
    expect(detail!.outcomeResults![0]).toMatchObject({
      contractId,
      verdict: 'FAIL',
      onViolation: 'halt',
    })
  })

  it('基础设施错误（TARGET_NOT_FOUND）：即便配置为 continue 也判定 UNKNOWN 且 Run 失败', async () => {
    browserBehavior = 'fail_infra'
    const contractId = newId()
    const step1Id = newId()

    const assertStep: Step = {
      id: step1Id,
      name: '目标丢失步骤',
      type: 'assert',
      effectType: 'READ_ONLY',
      input: {
        expect: { kind: 'text_equals', value: 'connected' },
      },
    }

    const contract: OutcomeContract = {
      id: contractId,
      scope: 'step',
      meaning: '检查连接',
      severity: 'MUST',
      onViolation: 'continue',
      provenance: 'manual',
      rule: {
        kind: 'deterministic',
        expect: { kind: 'text_equals', value: 'connected' },
      },
    }

    const scenario = await createScenarioWithNodes({
      name: '基础设施故障场景',
      nodes: [{ kind: 'step', step: assertStep, outcomes: [contract] }],
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })

    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })

    const run = await getRun(handle.db, created.detail.id)
    // 基础设施异常绝不转为成功！
    expect(run.status).toBe('FAILED')

    const detail = await loadRunDetail(handle.db, created.detail.id)
    expect(detail).toBeDefined()
    expect(detail!.outcomeStatus).toBe('UNKNOWN')
    expect(detail!.outcomeResults).toHaveLength(1)
    expect(detail!.outcomeResults![0]).toMatchObject({
      contractId,
      verdict: 'UNKNOWN',
      actual: null,
    })
  })

  function clickStep(id: string): Step {
    return {
      id,
      name: '点击',
      type: 'click',
      effectType: 'SIDE_EFFECT',
      input: { target: { framePath: [], candidates: [{ by: 'css', value: '#action-btn' }] } },
    }
  }

  function surfaceInvariant(id: string, onViolation: 'halt' | 'continue'): RuntimeInvariant {
    return {
      id,
      meaning: '不得出现系统错误弹窗',
      kind: 'error_surface',
      severity: 'MUST',
      onViolation,
      evaluateAt: 'before_side_effect',
    }
  }

  it('OCC-07：error_surface + halt 跳过执行器并截断后续步', async () => {
    surfaceMatches = [{ role: 'alertdialog', text: '系统异常' }]
    const invariantId = newId()
    const step1Id = newId()
    const step2Id = newId()
    const scenario = await createScenarioWithNodes({
      name: '错误弹窗停机',
      nodes: [
        { kind: 'step', step: clickStep(step1Id) },
        { kind: 'step', step: { id: step2Id, name: '后续', type: 'echo', effectType: 'READ_ONLY', input: { value: 'skip' } } },
      ],
      runtimeInvariants: [surfaceInvariant(invariantId, 'halt')],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.runtimeInvariantManifest?.entries).toHaveLength(1)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })

    expect(executeCalls).toBe(0)
    const run = await getRun(handle.db, created.detail.id)
    expect(run.status).toBe('FAILED')
    expect(run.stepRuns.find((item) => item.stepId === step2Id)?.status).toBe('SKIPPED')
    const detail = await loadRunDetail(handle.db, created.detail.id)
    expect(detail?.outcomeStatus).toBe('FAIL')
    expect(detail?.outcomeResults.some((row) => row.contractId === invariantId && row.verdict === 'FAIL')).toBe(true)
    expect(detail?.stepRuns.find((item) => item.stepId === step1Id)?.attempts[0]?.error).toMatchObject({
      code: 'ERROR_SURFACE_VIOLATED',
    })
  })

  it('OCC-05：探测抛错按未观察处理，不得写成 PASS', async () => {
    const originalProbe = mockBrowser.probeErrorSurface
    mockBrowser.probeErrorSurface = async () => {
      throw new Error('page gone')
    }
    try {
      const invariantId = newId()
      const scenario = await createScenarioWithNodes({
        name: '探测失败不写通过',
        nodes: [{ kind: 'step', step: clickStep(newId()) }],
        runtimeInvariants: [surfaceInvariant(invariantId, 'continue')],
      })
      const created = await createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        actor: { id: actorId },
      })
      const grant = await claimThis(created.detail.id)
      await engine.execute(created.detail.id, { grant })
      const detail = await loadRunDetail(handle.db, created.detail.id)
      expect(detail?.status).toBe('SUCCEEDED')
      expect(detail?.outcomeStatus).toBe('UNKNOWN')
      expect(detail?.outcomeResults.some((row) => row.contractId === invariantId)).toBe(false)
    } finally {
      mockBrowser.probeErrorSurface = originalProbe
    }
  })

  it('OCC-07：error_surface + continue 跑完且结果轴 FAIL', async () => {
    surfaceMatches = [{ role: 'alertdialog', text: '系统异常' }]
    const invariantId = newId()
    const step1Id = newId()
    const step2Id = newId()
    const scenario = await createScenarioWithNodes({
      name: '错误弹窗继续',
      nodes: [
        { kind: 'step', step: clickStep(step1Id) },
        { kind: 'step', step: { id: step2Id, name: '后续', type: 'echo', effectType: 'READ_ONLY', input: { value: 'after' } } },
      ],
      runtimeInvariants: [surfaceInvariant(invariantId, 'continue')],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.runtimeInvariantManifest?.entries).toHaveLength(1)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })

    expect(executeCalls).toBe(1)
    const run = await getRun(handle.db, created.detail.id)
    expect(run.status).toBe('SUCCEEDED')
    expect(run.stepRuns.find((item) => item.stepId === step2Id)?.status).toBe('SUCCEEDED')
    const detail = await loadRunDetail(handle.db, created.detail.id)
    expect(detail?.outcomeStatus).toBe('FAIL')
    expect(detail?.outcomeResults.some((row) => row.contractId === invariantId && row.verdict === 'FAIL')).toBe(true)
  })
})
