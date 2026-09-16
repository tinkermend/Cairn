import { afterEach, describe, expect, it } from 'vitest'
import { compileModuleContent, moduleWarningKey, type ModuleContent, type ScenarioAuthoringDocumentV2 } from '@cairn/shared'
import { newId } from '../id.js'
import * as api from '../index.js'
import { expose } from '../database.js'
import { openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'

describe('AM-F: 多实现发布与试跑', { timeout: 30_000 }, () => {
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
      email: `amf_${newId()}@test.com`,
      displayName: 'AM-F 测试',
      password: 'Password123!',
      roleIds: [admin.id],
    }, null)
    const targets = new api.TargetsStore(db, () => Buffer.from('fixture'))
    const target = await targets.createTarget({
      loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
      name: 'AM-F 目标',
      code: `AMF_${newId().slice(0, 8)}`,
      entryUrl: 'https://example.com',
    }, account)
    return { db, account, target }
  }

  function twoImplContent(): ModuleContent {
    return {
      contract: {
        inputs: [{ key: 'keyword', label: '关键词', valueType: 'string', required: true }],
        outputs: [{ key: 'result', label: '结果', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [{ meaning: '有结果', verification: { kind: 'output_required', outputKey: 'result' } }],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [{
            id: newId(),
            name: '主路径',
            type: 'echo',
            effectType: 'READ_ONLY',
            outputKey: 'internal',
            input: { from: 'keyword' },
          }],
          outputMapping: { result: 'internal' },
        },
        {
          implementationKey: 'alt',
          kind: 'structured_steps',
          steps: [{
            id: newId(),
            name: '备路径',
            type: 'echo',
            effectType: 'READ_ONLY',
            outputKey: 'internal',
            input: { from: 'keyword' },
          }],
          outputMapping: { result: 'internal' },
        },
      ],
    }
  }

  async function verifyImpl(
    db: ReturnType<typeof expose>,
    moduleId: string,
    accountId: string,
    implementationKey: string,
  ) {
    const prepared = await api.prepareModuleDraftTrial(db, moduleId, {
      inputs: { keyword: 'SO-1' },
      implementationKey,
      actor: { id: accountId },
    })
    const created = await api.createTrialRunFromDraft(db, prepared.scenarioId, {
      revision: prepared.revision,
      input: {},
      actor: { id: accountId },
    })
    const native = (await import('../database.js')).connection(db)
    const { schemaFor } = await import('../native.js')
    const { eq } = await import('drizzle-orm')
    const { runs, stepRuns, attempts } = schemaFor(native)
    const now = new Date()
    const steps = await native.select().from(stepRuns).where(eq(stepRuns.runId, created.detail.id))
    for (const step of steps) {
      await native.update(stepRuns).set({ status: 'SUCCEEDED', startedAt: now, finishedAt: now }).where(eq(stepRuns.id, step.id))
      await native.insert(attempts).values({
        id: newId(),
        stepRunId: step.id,
        attemptNo: 1,
        status: 'SUCCEEDED',
        startedAt: now,
        finishedAt: now,
        output: 'ok',
      })
    }
    await native.update(runs).set({
      status: 'SUCCEEDED',
      finishedAt: now,
      updatedAt: now,
      eventSeq: 3,
      context: { result: 'ok' },
    }).where(eq(runs.id, created.detail.id))
    await api.projectModuleInvocationResults(db, created.detail.id)
  }

  it('AMF-02 多实现必须各自有摘要一致的 VERIFIED 试跑', async () => {
    const { db, account, target } = await setup()
    const created = await api.createActionModule(db, {
      idempotencyKey: newId(),
      targetId: target.id,
      key: 'order.multi',
      name: '多实现',
      actor: { id: account.id },
    })
    const draft = await api.saveActionModuleDraft(db, created.id, {
      baseRevision: created.draftRevision ?? 0,
      content: twoImplContent(),
      actor: { id: account.id },
    })
    const warnings = compileModuleContent(twoImplContent(), { mode: 'release' })
      .diagnostics.filter((item) => item.severity === 'warning')
      .map(moduleWarningKey)
    await expect(api.publishActionModule(db, created.id, {
      idempotencyKey: newId(),
      expectedRevision: draft.draftRevision ?? 0,
      confirmedWarnings: warnings,
      actor: { id: account.id },
    })).rejects.toMatchObject({ code: 'MODULE_IMPLEMENTATION_UNVERIFIED' })

    await verifyImpl(db, created.id, account.id, 'default')
    await expect(api.publishActionModule(db, created.id, {
      idempotencyKey: newId(),
      expectedRevision: draft.draftRevision ?? 0,
      confirmedWarnings: warnings,
      actor: { id: account.id },
    })).rejects.toMatchObject({ code: 'MODULE_IMPLEMENTATION_UNVERIFIED' })

    await verifyImpl(db, created.id, account.id, 'alt')
    const published = await api.publishActionModule(db, created.id, {
      idempotencyKey: newId(),
      expectedRevision: draft.draftRevision ?? 0,
      confirmedWarnings: warnings,
      actor: { id: account.id },
    })
    expect(published.latestVersionNo).toBe(1)
  })

  it('AMF-09 候选顺序来自创建时快照，不读当前模块统计', async () => {
    const { db, account, target } = await setup()

    const config = await api.getOrCreatePlatformConfig(db)
    await api.updatePlatformConfig(db, {
      expectedRevision: config.revision,
      actor: { id: account.id },
      reason: 'enable fallback for AMF-09',
      document: {
        ...config.document,
        moduleFallback: { enabled: true },
      },
    })

    const created = await api.createActionModule(db, {
      idempotencyKey: newId(),
      targetId: target.id,
      key: 'order.query.snap',
      name: 'AMF09模块',
      actor: { id: account.id },
    })
    const draft = await api.saveActionModuleDraft(db, created.id, {
      baseRevision: created.draftRevision ?? 0,
      content: twoImplContent(),
      actor: { id: account.id },
    })
    const warnings = compileModuleContent(twoImplContent(), { mode: 'release' })
      .diagnostics.filter((item) => item.severity === 'warning')
      .map(moduleWarningKey)
    await verifyImpl(db, created.id, account.id, 'default')
    await verifyImpl(db, created.id, account.id, 'alt')
    await api.publishActionModule(db, created.id, {
      idempotencyKey: newId(),
      expectedRevision: draft.draftRevision ?? 0,
      confirmedWarnings: warnings,
      actor: { id: account.id },
    })
    const versions = await api.listActionModuleVersions(db, created.id)
    const versionId = versions.items[0]!.id

    const scenario = await api.createScenarioWithVersion(db, {
      targetId: target.id,
      name: 'AMF-09场景',
      steps: [{ id: newId(), name: '占位', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: account.id },
    })
    const invocationId = newId()
    const authoringDoc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'module',
          invocationId,
          moduleId: created.id,
          moduleVersionId: versionId,
          implementationKey: 'alt',
          inputBindings: { keyword: { kind: 'literal', value: 'AMF-09-KEY' } },
          outputBindings: { result: 'final_result' },
          selection: { mode: 'frozen_fallback', candidates: ['alt', 'default'] },
        },
      ],
    }
    const saved = await api.saveScenarioDraft(db, scenario.id, {
      revision: 1,
      document: authoringDoc,
      actor: { id: account.id },
    })
    await api.publishScenarioDraft(db, scenario.id, {
      revision: saved.draft?.revision ?? 2,
      actor: { id: account.id },
    })

    const run1 = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.id,
      actor: { id: account.id },
    })
    const snapshot1 = run1.detail.snapshot as {
      candidateGroups?: { groups?: Array<{ alternatives: Array<{ implementationKey: string }> }> }
    }
    expect(snapshot1.candidateGroups?.groups).toHaveLength(1)
    const alts1 = snapshot1.candidateGroups!.groups![0]!.alternatives
    expect(alts1.map((a) => a.implementationKey)).toEqual(['alt', 'default'])

    // 5. 产生运行结果并投影模块质量统计
    const native = (await import('../database.js')).connection(db)
    const { schemaFor } = await import('../native.js')
    const { eq } = await import('drizzle-orm')
    const { runs, stepRuns, attempts } = schemaFor(native)
    const now = new Date()
    const steps = await native.select().from(stepRuns).where(eq(stepRuns.runId, run1.detail.id))
    for (const step of steps) {
      await native.update(stepRuns).set({ status: 'SUCCEEDED', startedAt: now, finishedAt: now }).where(eq(stepRuns.id, step.id))
      await native.insert(attempts).values({
        id: newId(),
        stepRunId: step.id,
        attemptNo: 1,
        status: 'SUCCEEDED',
        startedAt: now,
        finishedAt: now,
        output: 'ok',
      })
    }
    await native.update(runs).set({
      status: 'SUCCEEDED',
      finishedAt: now,
      updatedAt: now,
      eventSeq: 3,
      context: { final_result: 'ok' },
    }).where(eq(runs.id, run1.detail.id))
    await api.projectModuleInvocationResults(db, run1.detail.id)

    const quality = await api.getActionModuleQuality(db, created.id)
    expect(quality.overall.sampleCount).toBeGreaterThanOrEqual(1)

    // 6. 创建 Run 2，快照中的候选顺序依然必须严格来自场景快照冻结的 ['alt', 'default']，绝不因模块质量统计而动态重排
    const run2 = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.id,
      actor: { id: account.id },
    })
    const snapshot2 = run2.detail.snapshot as {
      candidateGroups?: { groups?: Array<{ alternatives: Array<{ implementationKey: string }> }> }
    }
    expect(snapshot2.candidateGroups?.groups).toHaveLength(1)
    const alts2 = snapshot2.candidateGroups!.groups![0]!.alternatives
    expect(alts2.map((a) => a.implementationKey)).toEqual(['alt', 'default'])
  })
})

