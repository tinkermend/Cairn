import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  protocolCapabilitiesForRoles,
  ALL_WORKER_ROLES,
  type AiElementBinding,
  type AiPageObservation,
  type AiValueProvenance,
  type Step,
  BROWSER_AI_SDK_VERSION,
} from '@cairn/shared'
import {
  adjustPlatformConfig,
  appendAiTaskEvent,
  registerWorker,
  createRunWithSnapshot,
  createScenarioWithVersion,
  eq,
  listAiTaskEvents,
  queryAiPathInsights,
  settleAiActionTrace,
  startAttempt,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { registerPlatformAiSecret } from '../platform-config/index.js'
import { newId } from '../id.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
let consoleAccounts = pg_consoleAccounts
import { targets as pg_targets } from '../schema/targets.js'
let targets = pg_targets
import { forceGrantForRun, seedWorker } from './lease-harness.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_aipath`

const sampleAiStep: Step = {
  id: '00000000-0000-4000-8000-000000000099',
  name: '点击提交并填写表单',
  type: 'ai_action',
  effectType: 'SIDE_EFFECT',
  input: {
    instruction: '点击登录按钮',
  },
}

describe.each(DRIVERS)('%s AI 动作事实与路径度量', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    ;({ consoleAccounts, targets } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'tester',
      email: `ai-path-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `aip-${SCHEMA.slice(-6)}`,
      name: 'AI 路径夹具',
      entryUrl: 'https://example.com',
    })

    const secretId = newId()
    await registerPlatformAiSecret(handle.db, {
      id: secretId,
      baseUrl: 'https://model.example/v1',
      ciphertext: Buffer.from('encrypted'),
      actor: { id: actorId },
    })
    await adjustPlatformConfig(
      handle,
      { id: actorId },
      (document) => ({
        ...document,
        browserAi: {
          ...document.browserAi,
          enabled: true,
          baseUrl: 'https://model.example/v1',
          model: 'demo',
          modelFamily: 'openai',
          secretRef: { provider: 'local', secretId },
        },
      }),
      '测试：启用 Browser AI',
    )
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('全生命周期：记录 prepared、completed，执行收尾并聚合路径洞察', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: 'AI 动作事实测试',
      steps: [sampleAiStep],
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })

    const runId = created.detail.id
    const stepRunId = created.detail.stepRuns[0]!.id
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, runId, worker.workerId)

    const attempt = await startAttempt(handle.db, {
      runId,
      stepRunId,
      inputPayload: {},
      grant,
    })
    expect(attempt).not.toBeNull()
    const attemptId = attempt!.attemptId

    const pageBefore: AiPageObservation = {
      url: 'https://example.com/login',
      urlPattern: 'https://example.com/login',
      documentEpoch: 1,
      readyState: 'complete',
      timestamp: new Date().toISOString(),
    }

    const bindingFixed: AiElementBinding = {
      status: 'bound',
      redirected: false,
      candidates: [{ by: 'testId', value: 'login-btn' }],
      dataDependent: false,
      fingerprint: {
        tag: 'BUTTON',
        role: 'button',
        accessibleName: '登录',
        texts: ['登录'],
      },
    }

    const valueProvenanceFixed: AiValueProvenance = {
      kind: 'literal',
      source: 'literal',
      value: 'test-val',
    }

    // 1. 记录 prepared 事件
    const prep = await appendAiTaskEvent(handle.db, {
      attemptId,
      runId,
      stepRunId,
      agentInstanceId: 'agent-inst-1',
      ordinal: 0,
      phase: 'prepared',
      source: 'action_edge',
      actionName: 'Click',
      sdkVersion: BROWSER_AI_SDK_VERSION,
      elementDescription: '登录按钮',
      binding: bindingFixed,
      valueProvenance: valueProvenanceFixed,
      paramsSummary: { x: 100, y: 200 },
      pageBefore,
      grant,
    })
    expect(prep.ok).toBe(true)

    // 2. 记录 completed 事件
    const comp = await appendAiTaskEvent(handle.db, {
      attemptId,
      runId,
      stepRunId,
      agentInstanceId: 'agent-inst-1',
      ordinal: 0,
      phase: 'completed',
      source: 'action_edge',
      actionName: 'Click',
      sdkVersion: BROWSER_AI_SDK_VERSION,
      elementDescription: '登录按钮',
      binding: bindingFixed,
      valueProvenance: valueProvenanceFixed,
      paramsSummary: { x: 100, y: 200 },
      pageBefore,
      writeSignalCount: 1,
      writeSignalPaths: ['button[data-testid="login-btn"]'],
      durationMs: 45,
      grant,
    })
    expect(comp.ok).toBe(true)

    // 3. 读取事件列表
    const listRes = await listAiTaskEvents(handle.db, attemptId, {
      limit: 10,
    })
    expect(listRes.events).toHaveLength(2)
    expect(listRes.events[0]?.phase).toBe('prepared')
    expect(listRes.events[1]?.phase).toBe('completed')
    expect(listRes.events[1]?.actionName).toBe('Click')

    // 4. 收尾链路：settleAiActionTrace
    const settleRes = await settleAiActionTrace(handle.db, {
      attemptId,
      runId,
      stepRunId,
      step: sampleAiStep,
      snapshot: created.detail.snapshot,
      stepResult: 'SUCCEEDED',
    })

    expect(settleRes.ok).toBe(true)
    expect(settleRes.observation).not.toBeNull()
    expect(settleRes.observation?.solidifiableLevel).toBe('full')
    expect(settleRes.observation?.actionCount).toBe(1)
    expect(settleRes.observation?.signature).toBeDefined()
    expect(settleRes.observation?.stepDefinitionDigest).toBeDefined()

    // 5. 校验 aiPathObservations 表中的记录
    const { aiPathObservations: obsTable } = schemaFor(handle.db)
    const [obsRow] = await handle.db
      .select()
      .from(obsTable)
      .where(eq(obsTable.attemptId, attemptId))
    expect(obsRow).toBeDefined()
    expect(obsRow?.solidifiableLevel).toBe('full')
    expect(obsRow?.actionCount).toBe(1)
    expect(obsRow?.stepDefinitionDigest).toBe(settleRes.observation?.stepDefinitionDigest)

    // 6. 聚合洞察查询前，把 Attempt 置为终态（洞察的成功率以 Attempt 最终状态为准）
    const { attempts } = schemaFor(handle.db)
    await handle.db
      .update(attempts)
      .set({ status: 'SUCCEEDED', finishedAt: new Date() })
      .where(eq(attempts.id, attemptId))

    // 6. 聚合路径洞察查询
    const insights = await queryAiPathInsights(handle.db, scenario.id, {
      windowDays: 7,
    })

    expect(insights).toHaveLength(1)
    const insight = insights[0]!
    expect(insight.stepId).toBe(sampleAiStep.id)
    expect(insight.attemptsCount).toBe(1)
    expect(insight.successRate).toBe(1)
    expect(insight.topSignatureRatio).toBe(1)
    expect(insight.solidifiableLevelDistribution.full).toBe(1)
    expect(insight.latestEligibleAttempt?.signature).toBe(settleRes.observation?.signature)

    // 7. 软删除 Run 后，路径洞察不泄露该 Run 的观察数据 (AP13)
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        deletedAt: new Date(),
        deletedBy: { id: actorId, displayName: 'tester', kind: 'console' },
      })
      .where(eq(runs.id, runId))

    const insightsAfterDelete = await queryAiPathInsights(handle.db, scenario.id, {
      windowDays: 7,
    })
    expect(insightsAfterDelete).toHaveLength(0)
  })

  it('AP01/AP02 快照冻结：平台开启才写 aiTaskEvidence；Target 关闭则不写', async () => {
    // 滚动升级守卫：旧协议的存量 Worker 先下线（容量置 0），再登记声明 aiTaskEvidence 协议的 Worker
    const { workers } = schemaFor(handle.db)
    const staleAt = new Date(Date.now() - 3_600_000)
    await handle.db
      .update(workers)
      .set({ status: 'DRAINING', heartbeatAt: staleAt, heartbeatExpiresAt: staleAt })
      .where(eq(workers.status, 'READY'))
    await registerWorker(handle.db, {
      workerId: `ap0-capable-${newId()}`,
      instanceId: newId(),
      capacity: 4,
      protocolCapabilities: protocolCapabilitiesForRoles(ALL_WORKER_ROLES),
      lostAfterSeconds: 60,
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '快照冻结测试',
      steps: [sampleAiStep],
      actor: { id: actorId },
    })

    // 平台未开启：快照不写该字段
    const beforeEnable = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect((beforeEnable.detail.snapshot as Record<string, unknown>).aiTaskEvidence).toBeUndefined()

    // 平台开启：含 ai_action 的 Run 冻结 record
    await adjustPlatformConfig(
      handle,
      { id: actorId },
      (document) => ({ ...document, aiPathLearning: { ...document.aiPathLearning, actionTrace: true } }),
      '测试：开启 AI 动作采集',
    )
    const enabled = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect((enabled.detail.snapshot as { aiTaskEvidence?: { actionEdge?: string } }).aiTaskEvidence?.actionEdge).toBe('record')

    // Target 级关闭：不写该字段
    await handle.db.update(targets).set({ aiActionTrace: 'off' }).where(eq(targets.id, targetId))
    const targetOff = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect((targetOff.detail.snapshot as Record<string, unknown>).aiTaskEvidence).toBeUndefined()
    await handle.db.update(targets).set({ aiActionTrace: null }).where(eq(targets.id, targetId))
  })

  it('租约校验：当 grant 不匹配时拒绝追加动作事件', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '租约拦截测试',
      steps: [sampleAiStep],
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })

    const runId = created.detail.id
    const stepRunId = created.detail.stepRuns[0]!.id
    const worker = await seedWorker(handle)
    await forceGrantForRun(handle, runId, worker.workerId)

    const fakeGrant = {
      runId,
      leaseId: newId(),
      fencingToken: 99999,
      holderWorkerId: 'non-existent-worker',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }

    await expect(
      appendAiTaskEvent(handle.db, {
        attemptId: newId(),
        runId,
        stepRunId,
        agentInstanceId: 'inst-bad',
        ordinal: 0,
        phase: 'prepared',
        source: 'action_edge',
        actionName: 'Click',
        sdkVersion: BROWSER_AI_SDK_VERSION,
        binding: { status: 'not_applicable', redirected: false, candidates: [], dataDependent: false },
        valueProvenance: { kind: 'literal', source: 'literal', value: null },
        pageBefore: {
          url: 'https://example.com',
          urlPattern: 'https://example.com',
          documentEpoch: 1,
          readyState: 'complete',
          timestamp: new Date().toISOString(),
        },
        grant: fakeGrant,
      }),
    ).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })
  })
})
