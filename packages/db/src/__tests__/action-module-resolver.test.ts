import { afterEach, describe, expect, it } from 'vitest'
import { compileModuleContent, moduleWarningKey, type ModuleContent, type ScenarioAuthoringDocumentV2 } from '@cairn/shared'
import { newId } from '../id.js'
import * as api from '../index.js'
import { connection, expose } from '../database.js'
import { openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { eq } from 'drizzle-orm'

describe('AM-D: 编写期模块映射', { timeout: 30_000 }, () => {
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
      email: `amd_${newId()}@test.com`,
      displayName: 'AM-D 测试',
      password: 'Password123!',
      roleIds: [admin.id],
    }, null)
    const targets = new api.TargetsStore(db, () => Buffer.from('fixture'))
    const target = await targets.createTarget({
      loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
      name: 'AM-D 目标',
      code: `AMD_${newId().slice(0, 8)}`,
      entryUrl: 'https://example.com',
    }, account)
    const other = await targets.createTarget({
      loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
      name: 'AM-D 其他目标',
      code: `AMD2_${newId().slice(0, 8)}`,
      entryUrl: 'https://other.example.com',
    }, account)
    return { db, account, target, other }
  }

  function echoContent(name = '查询订单'): ModuleContent {
    return {
      contract: {
        inputs: [{ key: 'orderNo', label: '订单号', valueType: 'string', required: true }],
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
          name: name,
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'internal',
          input: { from: 'orderNo' },
        }],
        outputMapping: { result: 'internal' },
      }],
    }
  }

  async function publishCurrentDraft(db: ReturnType<typeof expose>, moduleId: string, accountId: string, expectedRevision: number) {
    const current = await api.getActionModule(db, moduleId)
    const warnings = current.draftContent
      ? compileModuleContent(current.draftContent, { mode: 'release' }).diagnostics.filter((item) => item.severity === 'warning').map(moduleWarningKey)
      : []
    return api.publishActionModule(db, moduleId, {
      idempotencyKey: newId(),
      expectedRevision,
      confirmedWarnings: warnings,
      actor: { id: accountId },
    })
  }

  async function publishNamed(
    db: ReturnType<typeof expose>,
    accountId: string,
    targetId: string,
    key: string,
    name: string,
    extra?: { aliases?: string[]; intentExamples?: string[] },
  ) {
    const created = await api.createActionModule(db, {
      idempotencyKey: newId(),
      targetId,
      key,
      name,
      actor: { id: accountId },
    })
    if (extra?.aliases || extra?.intentExamples) {
      await api.updateActionModuleMeta(db, created.id, {
        baseRevision: created.draftRevision ?? 0,
        aliases: extra.aliases,
        intentExamples: extra.intentExamples,
        actor: { id: accountId },
      })
    }
    const draft = await api.saveActionModuleDraft(db, created.id, {
      baseRevision: (await api.getActionModule(db, created.id)).draftRevision ?? 0,
      content: echoContent(name),
      actor: { id: accountId },
    })
    await publishCurrentDraft(db, created.id, accountId, draft.draftRevision ?? 0)
    const versions = await api.listActionModuleVersions(db, created.id)
    return { module: await api.getActionModule(db, created.id), versions: versions.items }
  }

  async function userScenario(db: ReturnType<typeof expose>, accountId: string, targetId: string) {
    return api.createScenarioWithVersion(db, {
      targetId,
      name: `场景 ${newId()}`,
      steps: [{ id: newId(), name: '占位', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: accountId },
    })
  }

  it('AMD-03 其他 Target 同名模块不出现', async () => {
    const { db, account, target, other } = await setup()
    const local = await publishNamed(db, account.id, target.id, 'order.query', '查询订单')
    const foreign = await publishNamed(db, account.id, other.id, 'order.query', '查询订单')
    const result = await api.resolveActionModules(db, {
      targetId: target.id,
      expression: '查询订单',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
      actor: { id: account.id },
    })
    expect(result.candidates.map((item) => item.moduleId)).toEqual([local.module.id])
    expect(result.candidates.some((item) => item.moduleId === foreign.module.id)).toBe(false)
  })

  it('AMD-05 无命中不创建 Run', async () => {
    const { db, account, target } = await setup()
    const scenario = await userScenario(db, account.id, target.id)
    const before = await api.countRunsForScenario(db, scenario.id)
    const result = await api.resolveActionModules(db, {
      targetId: target.id,
      scenarioId: scenario.id,
      expression: '煮咖啡',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
      actor: { id: account.id },
    })
    expect(result.status).toBe('no_match')
    expect(await api.countRunsForScenario(db, scenario.id)).toBe(before)
  })

  it('AMD-07 接受写入、OCC、幂等与候选外拒绝', async () => {
    const { db, account, target } = await setup()
    const published = await publishNamed(db, account.id, target.id, 'order.query', '查询订单', { aliases: ['查单'] })
    const scenario = await userScenario(db, account.id, target.id)
    const resolved = await api.resolveActionModules(db, {
      targetId: target.id,
      scenarioId: scenario.id,
      expression: '查询订单 SO123',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
      actor: { id: account.id },
    })
    const versionId = resolved.candidates[0]!.moduleVersionId
    const acceptKey = `accept-${newId()}`
    const first = await api.acceptModuleResolution(db, scenario.id, resolved.requestId, {
      moduleVersionId: versionId,
      inputBindings: { orderNo: { kind: 'literal', value: 'SO123' } },
      outputBindings: {},
      baseRevision: scenario.draft!.revision,
      idempotencyKey: acceptKey,
      actor: { id: account.id },
    })
    const nodes = (first.scenario as { draft?: { document: ScenarioAuthoringDocumentV2 } }).draft?.document.nodes
    expect(nodes?.some((node) => node.kind === 'module' && node.moduleVersionId === versionId)).toBe(true)

    const again = await api.acceptModuleResolution(db, scenario.id, resolved.requestId, {
      moduleVersionId: versionId,
      inputBindings: { orderNo: { kind: 'literal', value: 'CHANGED' } },
      outputBindings: {},
      baseRevision: scenario.draft!.revision,
      idempotencyKey: acceptKey,
      actor: { id: account.id },
    })
    expect((again.scenario as { draft?: { revision: number } }).draft?.revision).toBe(
      (first.scenario as { draft?: { revision: number } }).draft?.revision,
    )

    await expect(api.acceptModuleResolution(db, scenario.id, resolved.requestId, {
      moduleVersionId: versionId,
      inputBindings: {},
      outputBindings: {},
      baseRevision: scenario.draft!.revision,
      idempotencyKey: `accept-${newId()}`,
      actor: { id: account.id },
    })).rejects.toMatchObject({ code: 'RESOLUTION_ALREADY_SETTLED' })

    const second = await userScenario(db, account.id, target.id)
    const pending = await api.resolveActionModules(db, {
      targetId: target.id,
      scenarioId: second.id,
      expression: '查询订单',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
      actor: { id: account.id },
    })
    await expect(api.acceptModuleResolution(db, second.id, pending.requestId, {
      moduleVersionId: versionId,
      inputBindings: {},
      outputBindings: {},
      baseRevision: second.draft!.revision - 1,
      idempotencyKey: `accept-${newId()}`,
      actor: { id: account.id },
    })).rejects.toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT' })
    expect((await api.getModuleResolution(db, pending.requestId, { id: account.id })).outcome).toBe('pending')

    await expect(api.acceptModuleResolution(db, second.id, pending.requestId, {
      moduleVersionId: published.module.id,
      inputBindings: {},
      outputBindings: {},
      baseRevision: second.draft!.revision,
      idempotencyKey: `accept-${newId()}`,
      actor: { id: account.id },
    })).rejects.toMatchObject({ code: 'RESOLUTION_CANDIDATE_MISMATCH' })
  })

  it('AMD-08 发布后改别名不影响已发布定义', async () => {
    const { db, account, target } = await setup()
    const published = await publishNamed(db, account.id, target.id, 'order.query', '查询订单')
    const scenario = await userScenario(db, account.id, target.id)
    const resolved = await api.resolveActionModules(db, {
      targetId: target.id,
      scenarioId: scenario.id,
      expression: '查询订单',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
      actor: { id: account.id },
    })
    const accepted = await api.acceptModuleResolution(db, scenario.id, resolved.requestId, {
      moduleVersionId: resolved.candidates[0]!.moduleVersionId,
      inputBindings: { orderNo: { kind: 'literal', value: 'SO1' } },
      outputBindings: { result: 'result' },
      baseRevision: scenario.draft!.revision,
      idempotencyKey: `accept-${newId()}`,
      actor: { id: account.id },
    })
    const publishedScenario = await api.publishScenarioDraft(db, scenario.id, {
      revision: (accepted.scenario as { draft: { revision: number } }).draft.revision,
      actor: { id: account.id },
    })
    const before = await api.listScenarioVersions(db, scenario.id)
    const beforeDef = before.items[0]
    const firstRun = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.id,
      scenarioVersionId: publishedScenario.published?.versionId ?? publishedScenario.latestVersionId,
      actor: { id: account.id },
    })
    const firstSnapshot = {
      steps: firstRun.detail.snapshot.steps,
      moduleManifest: firstRun.detail.snapshot.moduleManifest,
    }

    await api.updateActionModuleMeta(db, published.module.id, {
      baseRevision: (await api.getActionModule(db, published.module.id)).draftRevision ?? 0,
      aliases: ['新别名'],
      actor: { id: account.id },
    })
    await publishNamed(db, account.id, target.id, 'order.lookalike', '查询订单')

    const after = await api.listScenarioVersions(db, scenario.id)
    expect(JSON.stringify(after.items[0]?.definition ?? after.items[0])).toBe(JSON.stringify(beforeDef?.definition ?? beforeDef))
    expect(publishedScenario.id).toBe(scenario.id)

    const secondRun = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.id,
      scenarioVersionId: publishedScenario.published?.versionId ?? publishedScenario.latestVersionId,
      actor: { id: account.id },
    })
    expect(secondRun.detail.snapshot.steps).toEqual(firstSnapshot.steps)
    expect(secondRun.detail.snapshot.moduleManifest).toEqual(firstSnapshot.moduleManifest)
  })

  it('只消费 confirmed 术语，不发明模块，也不写验证场景', async () => {
    const { db, account, target } = await setup()
    const published = await publishNamed(db, account.id, target.id, 'product.offshelf', '商品下架', {
      aliases: ['下架商品'],
    })
    await api.createTerminology(db, target.id, {
      idempotencyKey: `term-${newId()}`,
      canonicalName: '商品下架',
      aliases: ['下架'],
      meaning: '把在售商品改为下架',
      termStatus: 'confirmed',
    }, { id: account.id })
    await api.createTerminology(db, target.id, {
      idempotencyKey: `term-candidate-${newId()}`,
      canonicalName: '煮咖啡',
      aliases: ['煮一杯'],
      meaning: '候选术语不应参与映射',
    }, { id: account.id })

    const byTerm = await api.resolveActionModules(db, {
      targetId: target.id,
      expression: '下架',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
      actor: { id: account.id },
    })
    expect(byTerm.candidates[0]?.moduleId).toBe(published.module.id)
    expect(byTerm.candidates[0]?.matchedBy.some((item) => item.field === 'term')).toBe(true)
    expect(byTerm.termRevision).toBeTruthy()

    const candidateOnly = await api.resolveActionModules(db, {
      targetId: target.id,
      expression: '煮一杯',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
      actor: { id: account.id },
    })
    expect(candidateOnly.status).toBe('no_match')

    const verification = await api.prepareModuleDraftTrial(db, published.module.id, {
      inputs: { orderNo: 'SO-1' },
      actor: { id: account.id },
    })
    await expect(api.resolveActionModules(db, {
      targetId: target.id,
      scenarioId: verification.scenarioId,
      expression: '商品下架',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
      actor: { id: account.id },
    })).rejects.toMatchObject({ code: 'RESOLUTION_SCENARIO_NOT_WRITABLE' })
  })

  it('选中节点的输出可作为 from 建议', async () => {
    const { db, account, target } = await setup()
    await publishNamed(db, account.id, target.id, 'order.query', '查询订单')
    const scenario = await userScenario(db, account.id, target.id)
    const stepId = newId()
    const saved = await api.saveScenarioDraft(db, scenario.id, {
      revision: scenario.draft!.revision,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [{ key: 'keyword', label: '关键词' }],
        nodes: [{
          kind: 'step',
          step: {
            id: stepId,
            name: '提取单号',
            type: 'echo',
            effectType: 'READ_ONLY',
            outputKey: 'orderNo',
            input: { from: 'keyword' },
          },
        }],
      },
      actor: { id: account.id },
    })
    const resolved = await api.resolveActionModules(db, {
      targetId: target.id,
      scenarioId: scenario.id,
      anchorNodeId: stepId,
      expression: '查询订单 SO123',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
      actor: { id: account.id },
    })
    const versionId = resolved.candidates[0]!.moduleVersionId
    expect(resolved.inputSuggestions[versionId]?.orderNo).toEqual({ kind: 'from', key: 'orderNo', source: 'rule' })
    expect(saved.draft?.revision).toBeGreaterThan(scenario.draft!.revision)
  })

  it('AMD-12 脱敏、拒绝结果与过期清理', async () => {
    const { db, account, target } = await setup()
    await publishNamed(db, account.id, target.id, 'order.query', '查询订单')
    const resolved = await api.resolveActionModules(db, {
      targetId: target.id,
      expression: 'password=hunter2 查询订单',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
      actor: { id: account.id },
    })
    expect(['matched', 'suggested']).toContain(resolved.status)
    expect(resolved.candidates[0]?.name).toBe('查询订单')
    const native = connection(db)
    const { moduleResolutionRequests } = schemaFor(native)
    const [row] = await native.select().from(moduleResolutionRequests).where(eq(moduleResolutionRequests.id, resolved.requestId))
    expect(row?.expression).not.toContain('hunter2')
    expect(row?.expression).toContain('***')

    const closed = await api.closeModuleResolution(db, resolved.requestId, {
      outcome: 'rejected',
      actor: { id: account.id },
    })
    expect(closed.outcome).toBe('rejected')

    await native.update(moduleResolutionRequests).set({ createdAt: new Date('2026-01-01T00:00:00.000Z') }).where(eq(moduleResolutionRequests.id, resolved.requestId))
    expect(await api.purgeExpiredModuleResolutions(db, 30, new Date('2026-09-16T00:00:00.000Z'))).toBe(1)
    await expect(api.getModuleResolution(db, resolved.requestId, { id: account.id })).rejects.toMatchObject({ code: 'RESOLUTION_NOT_FOUND' })
  })

  it('withdrawn 不进入候选，rules_then_ai 标记 AI 层未开放', async () => {
    const { db, account, target } = await setup()
    const published = await publishNamed(db, account.id, target.id, 'product.delete', '删除商品')
    await api.updateModulePublication(db, published.module.id, published.versions[0]!.id, {
      status: 'withdrawn',
      reason: '有缺陷',
      actor: { id: account.id },
    })
    const result = await api.resolveActionModules(db, {
      targetId: target.id,
      expression: '删除商品',
      mode: 'rules_then_ai',
      idempotencyKey: `resolve-${newId()}`,
      actor: { id: account.id },
    })
    expect(result.status).toBe('no_match')
    expect(result.aiSkipped).toBe('ai_layer_not_open')
  })
})
