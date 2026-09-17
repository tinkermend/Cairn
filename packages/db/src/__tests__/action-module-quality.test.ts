import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { compileModuleContent, moduleWarningKey, type ModuleContent, type ScenarioAuthoringDocumentV2 } from '@cairn/shared'
import { newId } from '../id.js'
import * as api from '../index.js'
import { connection, expose } from '../database.js'
import { openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'

describe('AM-E: 模块调用结果投影与统计', { timeout: 30_000 }, () => {
  const handles: DbHandle[] = []
  afterEach(async () => {
    for (const handle of handles.splice(0).reverse()) await handle.close()
  })

  async function setup() {
    const handle = await openContractDb('postgres')
    handles.push(handle)
    const db = expose(handle)
    const rbac = new api.RbacStore(db, { hash: async (v) => v, verify: async (v, h) => v === h })
    const admin = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!
    const account = await rbac.createAccount({
      email: `ame_${newId()}@test.com`,
      displayName: 'AM-E 测试',
      password: 'Password123!',
      roleIds: [admin.id],
    }, null)
    const targets = new api.TargetsStore(db, () => Buffer.from('fixture'))
    const target = await targets.createTarget({
      loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
      name: 'AM-E 目标',
      code: `AME_${newId().slice(0, 8)}`,
      entryUrl: 'https://example.com',
    }, account)
    return { db, account, target }
  }

  function echoContent(): ModuleContent {
    return {
      contract: {
        inputs: [{ key: 'keyword', label: '关键词', valueType: 'string', required: true }],
        outputs: [{ key: 'result', label: '结果', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [{ meaning: '有结果', verification: { kind: 'output_required', outputKey: 'result' } }],
      },
      implementations: [{
        implementationKey: 'default',
        kind: 'structured_steps',
        steps: [{
          id: newId(),
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'internal',
          input: { from: 'keyword' },
        }],
        outputMapping: { result: 'internal' },
      }],
    }
  }

  async function publishModule(db: ReturnType<typeof expose>, accountId: string, targetId: string, key = 'order.query') {
    const created = await api.createActionModule(db, {
      idempotencyKey: newId(),
      targetId,
      key,
      name: '查询订单',
      actor: { id: accountId },
    })
    const draft = await api.saveActionModuleDraft(db, created.id, {
      baseRevision: created.draftRevision ?? 0,
      content: echoContent(),
      actor: { id: accountId },
    })
    const current = await api.getActionModule(db, created.id)
    const warnings = current.draftContent
      ? compileModuleContent(current.draftContent, { mode: 'release' }).diagnostics
        .filter((item) => item.severity === 'warning')
        .map(moduleWarningKey)
      : []
    await api.publishActionModule(db, created.id, {
      idempotencyKey: newId(),
      expectedRevision: draft.draftRevision ?? 0,
      confirmedWarnings: warnings,
      actor: { id: accountId },
    })
    const versions = await api.listActionModuleVersions(db, created.id)
    return { module: await api.getActionModule(db, created.id), version: versions.items[0]! }
  }

  async function publishScenarioWithModule(
    db: ReturnType<typeof expose>,
    accountId: string,
    targetId: string,
    moduleId: string,
    versionId: string,
    extraInvocations = 0,
  ) {
    const scenario = await api.createScenarioWithVersion(db, {
      targetId,
      name: `场景 ${newId()}`,
      steps: [{ id: newId(), name: '占位', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: accountId },
    })
    const nodes: ScenarioAuthoringDocumentV2['nodes'] = []
    const invocationIds: string[] = []
    for (let i = 0; i <= extraInvocations; i += 1) {
      const invocationId = newId()
      invocationIds.push(invocationId)
      nodes.push({
        kind: 'module',
        invocationId,
        moduleId,
        moduleVersionId: versionId,
        implementationKey: 'default',
        inputBindings: { keyword: { kind: 'literal', value: 'SO123' } },
        outputBindings: { result: i === 0 ? 'result' : `result_${i}` },
      })
    }
    const draft: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes,
    }
    const saved = await api.saveScenarioDraft(db, scenario.id, {
      revision: 1,
      document: draft,
      actor: { id: accountId },
    })
    await api.publishScenarioDraft(db, scenario.id, {
      revision: saved.draft?.revision ?? 2,
      actor: { id: accountId },
    })
    const published = await api.getScenario(db, scenario.id)
    return { scenario: published, invocationIds, draftRevision: saved.draft?.revision ?? 2 }
  }

  async function markRun(
    db: ReturnType<typeof expose>,
    runId: string,
    input: {
      status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'NEEDS_REVIEW'
      stepStatus?: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'PENDING'
      error?: { code: string; category: string }
      context?: Record<string, unknown>
      eventSeq?: number
    },
  ) {
    const native = connection(db)
    const { runs, stepRuns, attempts } = schemaFor(native)
    const now = new Date()
    const steps = await native.select().from(stepRuns).where(eq(stepRuns.runId, runId))
    for (const step of steps) {
      await native.update(stepRuns).set({
        status: input.stepStatus ?? (input.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED'),
        startedAt: now,
        finishedAt: now,
      }).where(eq(stepRuns.id, step.id))
      await native.insert(attempts).values({
        id: newId(),
        stepRunId: step.id,
        attemptNo: 1,
        status: input.stepStatus === 'SUCCEEDED' || input.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
        startedAt: now,
        finishedAt: now,
        output: input.stepStatus === 'SUCCEEDED' || input.status === 'SUCCEEDED' ? 'ok' : null,
        error: input.error ?? null,
      })
    }
    await native.update(runs).set({
      status: input.status,
      finishedAt: input.status === 'NEEDS_REVIEW' ? null : now,
      updatedAt: now,
      eventSeq: input.eventSeq ?? 3,
      ...(input.context ? { context: input.context } : {}),
    }).where(eq(runs.id, runId))
  }

  it('AME-04/07 同一 Run 两次调用各一行，重复投影不增加行', async () => {
    const { db, account, target } = await setup()
    const published = await publishModule(db, account.id, target.id)
    const scenario = await publishScenarioWithModule(db, account.id, target.id, published.module.id, published.version.id, 1)
    const created = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.scenario.id,
      actor: { id: account.id },
    })
    await markRun(db, created.detail.id, { status: 'SUCCEEDED', stepStatus: 'SUCCEEDED', context: { result: 'ok', result_1: 'ok' } })
    const first = await api.projectModuleInvocationResults(db, created.detail.id)
    const second = await api.projectModuleInvocationResults(db, created.detail.id)
    expect(first.projected).toBe(2)
    expect(second.projected).toBe(2)
    const listed = await api.listModuleInvocations(db, published.module.id)
    expect(listed.total).toBe(2)
    expect(new Set(listed.items.map((item) => item.invocationId)).size).toBe(2)
  })

  it('AME-05 补算扫描补齐丢失的投影', async () => {
    const { db, account, target } = await setup()
    const published = await publishModule(db, account.id, target.id, 'order.backfill')
    const scenario = await publishScenarioWithModule(db, account.id, target.id, published.module.id, published.version.id)
    const created = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.scenario.id,
      actor: { id: account.id },
    })
    await markRun(db, created.detail.id, { status: 'SUCCEEDED', stepStatus: 'SUCCEEDED', context: { result: 'ok' } })
    const before = await api.listModuleInvocations(db, published.module.id)
    expect(before.total).toBe(0)
    const filled = await api.backfillModuleInvocationResults(db, { limit: 20 })
    expect(filled.projected).toBeGreaterThanOrEqual(1)
    expect((await api.listModuleInvocations(db, published.module.id)).total).toBe(1)
  })

  it('AME-03/06 外部失败不进分母，复核后更新且不改 Attempt', async () => {
    const { db, account, target } = await setup()
    const published = await publishModule(db, account.id, target.id, 'order.review')
    const scenario = await publishScenarioWithModule(db, account.id, target.id, published.module.id, published.version.id)
    const created = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.scenario.id,
      actor: { id: account.id },
    })
    const native = connection(db)
    const { runs, attempts } = schemaFor(native)
    await native.update(runs).set({
      authCheckpoint: {
        schemaVersion: 1,
        status: 'unrecoverable',
        closedAt: new Date().toISOString(),
        trigger: { kind: 'navigated_to_login', at: new Date().toISOString(), summary: '回到登录页' },
        nextStepId: created.detail.snapshot.steps[0]!.id,
        nextOrdinal: 0,
        interruptedClassification: 'none',
        contextVersion: 'v',
        contextKeys: [],
        sessionGeneration: 1,
        fencingToken: 't',
        recoveryRule: { reuse: 'NEW_PAGE', entryUrl: 'https://example.com/', allowedOrigins: ['https://example.com'] },
        capability: 'LEGACY',
        autoRecoveriesUsed: 0,
        manualRecoveriesUsed: 0,
      },
    }).where(eq(runs.id, created.detail.id))
    await markRun(db, created.detail.id, {
      status: 'NEEDS_REVIEW',
      stepStatus: 'FAILED',
      error: { code: 'TARGET_NOT_FOUND', category: 'EXECUTOR' },
    })
    await api.projectModuleInvocationResults(db, created.detail.id)
    const reviewing = await api.listModuleInvocations(db, published.module.id)
    expect(reviewing.items[0]).toMatchObject({ outcome: 'NEEDS_REVIEW', attribution: 'UNKNOWN' })
    const attemptBefore = await native.select().from(attempts)
    await api.reviewRun(db, { runId: created.detail.id, actor: { id: account.id }, conclusion: 'fail' })
    const after = await api.listModuleInvocations(db, published.module.id)
    expect(after.items[0]?.outcome).toBe('FAILED_IMPLEMENTATION')
    expect(after.items[0]?.attribution).toBe('EXTERNAL_INFRA')
    const quality = await api.getActionModuleQuality(db, published.module.id, { window: 7 })
    expect(quality.overall.externalInfra).toBe(1)
    expect(quality.overall.sampleCount).toBe(0)
    expect(quality.overall.verifiedRate).toBeNull()
    const attemptAfter = await native.select().from(attempts)
    expect(attemptAfter.map((item) => item.id).sort()).toEqual(attemptBefore.map((item) => item.id).sort())
  })

  it('AME-08 试跑不进入正式通过率', async () => {
    const { db, account, target } = await setup()
    const published = await publishModule(db, account.id, target.id, 'order.trial')
    const scenario = await publishScenarioWithModule(db, account.id, target.id, published.module.id, published.version.id)
    const trialVersion = await api.prepareTrialVersion(db, scenario.scenario.id, {
      revision: scenario.draftRevision,
      runInput: {},
      actor: { id: account.id },
    })
    const trial = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.scenario.id,
      scenarioVersionId: trialVersion.versionId,
      actor: { id: account.id },
      allowTrialVersion: true,
    })
    await markRun(db, trial.detail.id, { status: 'SUCCEEDED', stepStatus: 'SUCCEEDED', context: { result: 'ok' } })
    await api.projectModuleInvocationResults(db, trial.detail.id)
    const listed = await api.listModuleInvocations(db, published.module.id)
    expect(listed.items[0]?.runKind).toBe('trial')
    const quality = await api.getActionModuleQuality(db, published.module.id, { window: 7 })
    expect(quality.overall.calls).toBe(0)
    expect(quality.trial.calls).toBe(1)
    expect(quality.health.signal).toBe('unknown')
    const catalog = await api.listActionModules(db, { targetId: target.id })
    const withHealth = await api.attachModuleListHealth(db, catalog.items.filter((item) => item.id === published.module.id))
    expect(withHealth[0]?.health).toMatchObject({
      signal: quality.health.signal,
      sampleCount: quality.health.sampleCount,
      verifiedRate: quality.health.verifiedRate,
      windowDays: quality.health.windowDays,
      configRevision: quality.health.configRevision,
      verificationInsufficient: quality.health.verificationInsufficient,
    })
  })

  it('列表健康一次批量装载，与单模块质量摘要一致且不计入窗口外行', async () => {
    const { db, account, target } = await setup()
    expect(await api.attachModuleListHealth(db, [])).toEqual([])
    const verified = await publishModule(db, account.id, target.id, 'order.list.ok')
    const failed = await publishModule(db, account.id, target.id, 'order.list.fail')
    const verifiedScenario = await publishScenarioWithModule(db, account.id, target.id, verified.module.id, verified.version.id)
    const failedScenario = await publishScenarioWithModule(db, account.id, target.id, failed.module.id, failed.version.id)
    const aged = await api.createRunWithSnapshot(db, {
      scenarioId: verifiedScenario.scenario.id,
      actor: { id: account.id },
    })
    await markRun(db, aged.detail.id, { status: 'SUCCEEDED', stepStatus: 'SUCCEEDED', context: { result: 'ok' } })
    await api.projectModuleInvocationResults(db, aged.detail.id)
    const recent = await api.createRunWithSnapshot(db, {
      scenarioId: verifiedScenario.scenario.id,
      actor: { id: account.id },
    })
    await markRun(db, recent.detail.id, { status: 'SUCCEEDED', stepStatus: 'SUCCEEDED', context: { result: 'ok' } })
    await api.projectModuleInvocationResults(db, recent.detail.id)
    const failedRun = await api.createRunWithSnapshot(db, {
      scenarioId: failedScenario.scenario.id,
      actor: { id: account.id },
    })
    await markRun(db, failedRun.detail.id, {
      status: 'FAILED',
      stepStatus: 'FAILED',
      error: { code: 'STEP_FAILED', category: 'EXECUTOR' },
    })
    await api.projectModuleInvocationResults(db, failedRun.detail.id)

    const native = connection(db)
    const { moduleInvocationResults } = schemaFor(native)
    await native.update(moduleInvocationResults).set({
      finishedAt: new Date(Date.now() - 40 * 86_400_000),
    }).where(eq(moduleInvocationResults.runId, aged.detail.id))

    const listed = await api.listActionModules(db, { targetId: target.id, pageSize: 20 })
    const withHealth = await api.attachModuleListHealth(db, listed.items)
    expect(withHealth).toHaveLength(listed.items.length)
    for (const item of withHealth) {
      const quality = await api.getActionModuleQuality(db, item.id, { window: 7, groupBy: 'none' })
      expect(item.health).toMatchObject({
        signal: quality.health.signal,
        sampleCount: quality.health.sampleCount,
        verifiedRate: quality.health.verifiedRate,
        windowDays: quality.health.windowDays,
        configRevision: quality.health.configRevision,
        verificationInsufficient: quality.health.verificationInsufficient,
      })
    }
    const verifiedHealth = withHealth.find((item) => item.id === verified.module.id)?.health
    const failedHealth = withHealth.find((item) => item.id === failed.module.id)?.health
    expect(verifiedHealth?.sampleCount).toBe(1)
    expect(verifiedHealth?.verifiedRate).toBe(1)
    expect(failedHealth?.sampleCount).toBe(1)
    expect(failedHealth?.verifiedRate).toBe(0)
  })

  it('AME-12 同一 Run+invocation 不能插入第二行', async () => {
    const { db, account, target } = await setup()
    const published = await publishModule(db, account.id, target.id, 'order.unique')
    const scenario = await publishScenarioWithModule(db, account.id, target.id, published.module.id, published.version.id)
    const created = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.scenario.id,
      actor: { id: account.id },
    })
    await markRun(db, created.detail.id, { status: 'SUCCEEDED', stepStatus: 'SUCCEEDED', context: { result: 'ok' } })
    await api.projectModuleInvocationResults(db, created.detail.id)
    const native = connection(db)
    const { moduleInvocationResults } = schemaFor(native)
    const [row] = await native.select().from(moduleInvocationResults).where(eq(moduleInvocationResults.runId, created.detail.id))
    await expect(native.insert(moduleInvocationResults).values({
      ...row!,
      id: newId(),
    })).rejects.toThrow()
  })
})
