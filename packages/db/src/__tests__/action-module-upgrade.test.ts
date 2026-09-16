import { afterEach, describe, expect, it } from 'vitest'
import { compileModuleContent, moduleWarningKey, type ModuleContent, type ScenarioAuthoringDocumentV2, type Step } from '@cairn/shared'
import { newId } from '../id.js'
import * as api from '../index.js'
import { expose } from '../database.js'
import { openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'

describe('AM-C: 升级、发布状态、提炼与删除保护', { timeout: 30_000 }, () => {
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
      email: `amc_${newId()}@test.com`,
      displayName: 'AM-C 测试',
      password: 'Password123!',
      roleIds: [admin.id],
    }, null)
    const targets = new api.TargetsStore(db, () => Buffer.from('fixture'))
    const target = await targets.createTarget({
      loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
      name: 'AM-C 目标',
      code: `AMC_${newId().slice(0, 8)}`,
      entryUrl: 'https://example.com',
    }, account)
    return { db, account, target }
  }

  function echoContent(extraInputs: ModuleContent['contract']['inputs'] = []): ModuleContent {
    return {
      contract: {
        inputs: [{ key: 'keyword', label: '关键词', valueType: 'string', required: true }, ...extraInputs],
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

  async function publishModule(db: ReturnType<typeof expose>, accountId: string, targetId: string, key: string, content: ModuleContent) {
    const created = await api.createActionModule(db, {
      idempotencyKey: newId(),
      targetId,
      key,
      name: key,
      actor: { id: accountId },
    })
    const draft = await api.saveActionModuleDraft(db, created.id, {
      baseRevision: created.draftRevision ?? 0,
      content,
      actor: { id: accountId },
    })
    await publishCurrentDraft(db, created.id, accountId, draft.draftRevision ?? 0)
    const versions = await api.listActionModuleVersions(db, created.id)
    return { module: created, versions: versions.items }
  }

  async function publishCurrentDraft(
    db: ReturnType<typeof expose>,
    moduleId: string,
    accountId: string,
    expectedRevision: number,
  ) {
    const current = await api.getActionModule(db, moduleId)
    const warnings = current.draftContent
      ? compileModuleContent(current.draftContent, { mode: 'release' }).diagnostics
          .filter((item) => item.severity === 'warning')
          .map(moduleWarningKey)
      : []
    return api.publishActionModule(db, moduleId, {
      idempotencyKey: newId(),
      expectedRevision,
      confirmedWarnings: warnings,
      actor: { id: accountId },
    })
  }

  async function userScenario(db: ReturnType<typeof expose>, accountId: string, targetId: string, name: string, document: ScenarioAuthoringDocumentV2) {
    const created = await api.createScenarioWithVersion(db, {
      targetId,
      name,
      steps: [{
        id: newId(),
        name: '占位',
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 10 },
      }],
      actor: { id: accountId },
    })
    return api.saveScenarioDraft(db, created.id, {
      revision: created.draft!.revision,
      document,
      actor: { id: accountId },
    })
  }

  function invocationDoc(moduleId: string, versionId: string, invocationId = newId()): ScenarioAuthoringDocumentV2 {
    return {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [{ key: 'keyword', label: '关键词' }],
      nodes: [{
        kind: 'module',
        invocationId,
        name: '查询',
        moduleId,
        moduleVersionId: versionId,
        implementationKey: 'default',
        inputBindings: { keyword: { kind: 'from', key: 'keyword' } },
        outputBindings: { result: 'result' },
      }],
    }
  }

  it('AMC-01 引用列表区分草稿与已发布版本', async () => {
    const { db, account, target } = await setup()
    const { module, versions } = await publishModule(db, account.id, target.id, 'order.query', echoContent())
    const v1 = versions[0]!
    const draft = await api.saveActionModuleDraft(db, module.id, {
      baseRevision: (await api.getActionModule(db, module.id)).draftRevision ?? 0,
      content: echoContent([{ key: 'limit', label: '条数', valueType: 'number', required: false }]),
      actor: { id: account.id },
    })
    await publishCurrentDraft(db, module.id, account.id, draft.draftRevision ?? 0)
    const v2 = (await api.listActionModuleVersions(db, module.id)).items[0]!

    const a = await userScenario(db, account.id, target.id, '场景甲', invocationDoc(module.id, v1.id))
    const b = await userScenario(db, account.id, target.id, '场景乙', invocationDoc(module.id, v1.id))
    await api.publishScenarioDraft(db, b.id, { revision: b.draft!.revision, actor: { id: account.id } })
    await api.saveScenarioDraft(db, b.id, {
      revision: (await api.getScenario(db, b.id)).draft!.revision,
      document: invocationDoc(module.id, v2.id, newId()),
      actor: { id: account.id },
    })

    const refs = await api.listModuleReferences(db, module.id, { page: 1, pageSize: 20 })
    const alpha = refs.items.find((item) => item.scenarioId === a.id)!
    const beta = refs.items.find((item) => item.scenarioId === b.id)!
    expect(alpha.draftUses[0]?.versionNo).toBe(1)
    expect(alpha.publishedUses).toEqual([])
    expect(beta.publishedUses[0]?.versionNo).toBe(1)
    expect(beta.draftUses[0]?.versionNo).toBe(2)
    expect(beta.upgradeAvailable).toBe(true)

    const verification = await api.getOrCreateModuleVerificationScenario(db, {
      moduleId: module.id,
      actor: { id: account.id },
    })
    const withVerification = await api.listModuleReferences(db, module.id, { page: 1, pageSize: 20 })
    expect(withVerification.items.find((item) => item.scenarioId === verification.scenarioId)?.purpose).toBe('module_verification')

    const gone = await new api.TargetsStore(db, () => Buffer.from('fixture')).createTarget({
      loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
      name: '将删除',
      code: `GONE_${newId().slice(0, 8)}`,
      entryUrl: 'https://gone.example',
    }, account)
    const hidden = await userScenario(db, account.id, gone.id, '已删目标场景', invocationDoc(module.id, v1.id))
    await new api.TargetsStore(db, () => Buffer.from('fixture')).deleteTarget(gone.id, account)
    const afterDelete = await api.listModuleReferences(db, module.id, { page: 1, pageSize: 50 })
    expect(afterDelete.items.some((item) => item.scenarioId === hidden.id)).toBe(false)
  })

  it('AMC-03/06 升级只写草稿，补绑定后成功，幂等只写一次', async () => {
    const { db, account, target } = await setup()
    const { module, versions } = await publishModule(db, account.id, target.id, 'order.upgrade', echoContent())
    const v1 = versions[0]!
    const next = await api.saveActionModuleDraft(db, module.id, {
      baseRevision: (await api.getActionModule(db, module.id)).draftRevision ?? 0,
      content: echoContent([{ key: 'limit', label: '条数', valueType: 'number', required: true }]),
      actor: { id: account.id },
    })
    await publishCurrentDraft(db, module.id, account.id, next.draftRevision ?? 0)
    const v2 = (await api.listActionModuleVersions(db, module.id)).items[0]!
    const invocationId = newId()
    const scenario = await userScenario(db, account.id, target.id, '待升级', invocationDoc(module.id, v1.id, invocationId))
    const beforeVersions = (await api.listScenarioVersions(db, scenario.id)).items.length

    const preview = await api.previewScenarioModuleUpgrade(db, scenario.id, { invocationId, toVersionId: v2.id })
    expect(preview.diffs.some((item) => item.code === 'MODULE_UPGRADE_INPUT_REQUIRED')).toBe(true)
    await expect(api.upgradeScenarioModuleDraft(db, scenario.id, {
      invocationId,
      toVersionId: v2.id,
      baseRevision: scenario.draft!.revision,
      idempotencyKey: newId(),
      actor: { id: account.id },
    })).rejects.toMatchObject({ code: 'MODULE_UPGRADE_BLOCKED' })

    const key = newId()
    const upgraded = await api.upgradeScenarioModuleDraft(db, scenario.id, {
      invocationId,
      toVersionId: v2.id,
      baseRevision: scenario.draft!.revision,
      bindingsPatch: { limit: { kind: 'literal', value: 10 } },
      idempotencyKey: key,
      actor: { id: account.id },
    })
    const node = upgraded.draft && 'nodes' in (upgraded.draft.document as ScenarioAuthoringDocumentV2)
      ? (upgraded.draft.document as ScenarioAuthoringDocumentV2).nodes.find((item) => item.kind === 'module')
      : undefined
    expect(node && node.kind === 'module' ? node.moduleVersionId : undefined).toBe(v2.id)
    expect((await api.listScenarioVersions(db, scenario.id)).items.length).toBe(beforeVersions)
    const compile = await api.previewScenarioExpansion(db, upgraded.id, {})
    expect(compile.diagnostics.filter((item) => item.severity === 'error')).toEqual([])

    const replay = await api.upgradeScenarioModuleDraft(db, scenario.id, {
      invocationId,
      toVersionId: v2.id,
      baseRevision: scenario.draft!.revision,
      bindingsPatch: { limit: { kind: 'literal', value: 10 } },
      idempotencyKey: key,
      actor: { id: account.id },
    })
    expect(replay.draft?.revision).toBe(upgraded.draft?.revision)

    await expect(api.upgradeScenarioModuleDraft(db, scenario.id, {
      invocationId,
      toVersionId: v2.id,
      baseRevision: 0,
      bindingsPatch: { limit: { kind: 'literal', value: 10 } },
      idempotencyKey: newId(),
      actor: { id: account.id },
    })).rejects.toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT' })
  })

  it('AMC-07 批量升级逐行跳过冲突、阻断和验证场景', async () => {
    const { db, account, target } = await setup()
    const { module, versions } = await publishModule(db, account.id, target.id, 'order.batch', echoContent())
    const v1 = versions[0]!
    const next = await api.saveActionModuleDraft(db, module.id, {
      baseRevision: (await api.getActionModule(db, module.id)).draftRevision ?? 0,
      content: echoContent([{ key: 'limit', label: '条数', valueType: 'number', required: true }]),
      actor: { id: account.id },
    })
    await publishCurrentDraft(db, module.id, account.id, next.draftRevision ?? 0)
    const v2 = (await api.listActionModuleVersions(db, module.id)).items[0]!
    const okContent = echoContent()
    await api.saveActionModuleDraft(db, module.id, {
      baseRevision: (await api.getActionModule(db, module.id)).draftRevision ?? 0,
      content: {
        ...okContent,
        implementations: [{
          ...okContent.implementations[0]!,
          steps: [{ ...okContent.implementations[0]!.steps[0]!, name: '回显v3' }],
        }],
      },
      actor: { id: account.id },
    })
    // v3: same contract as v1 (implementation only) — publish after resetting inputs
    const implOnly = echoContent()
    const implDraft = await api.saveActionModuleDraft(db, module.id, {
      baseRevision: (await api.getActionModule(db, module.id)).draftRevision ?? 0,
      content: {
        ...implOnly,
        implementations: [{
          ...implOnly.implementations[0]!,
          steps: [{ ...implOnly.implementations[0]!.steps[0]!, name: '实现变化' }],
        }],
      },
      actor: { id: account.id },
    })
    await publishCurrentDraft(db, module.id, account.id, implDraft.draftRevision ?? 0)
    const latest = (await api.listActionModuleVersions(db, module.id)).items[0]!

    const success: string[] = []
    for (const name of ['成1', '成2', '成3']) {
      const row = await userScenario(db, account.id, target.id, name, invocationDoc(module.id, v1.id))
      success.push(row.id)
    }
    const blockedDoc = invocationDoc(module.id, v1.id)
    const blockedNode = blockedDoc.nodes[0]
    if (blockedNode?.kind === 'module') blockedNode.inputBindings = { keyword: { kind: 'literal', value: 123 } }
    const blocked = await userScenario(db, account.id, target.id, '阻断', blockedDoc)
    const verification = await api.getOrCreateModuleVerificationScenario(db, {
      moduleId: module.id,
      actor: { id: account.id },
    })
    const warnScenario = await userScenario(db, account.id, target.id, '警告', invocationDoc(module.id, v1.id))

    const result = await api.batchUpgradeModuleDrafts(db, module.id, {
      toVersionId: latest.id,
      scenarioIds: [...success, blocked.id, verification.scenarioId],
      idempotencyKey: newId(),
      actor: { id: account.id },
    })
    expect(result.results.filter((item) => item.status === 'upgraded')).toHaveLength(3)
    expect(result.results.find((item) => item.scenarioId === blocked.id)?.status).toBe('skipped')
    expect(result.results.find((item) => item.scenarioId === blocked.id)?.code).toMatch(/MODULE_UPGRADE_BLOCKED|MODULE_INPUT_TYPE/)
    expect(result.results.find((item) => item.scenarioId === verification.scenarioId)).toMatchObject({
      status: 'skipped',
      code: 'MODULE_VERIFICATION_NOT_BATCHABLE',
    })

    await api.updateModulePublication(db, module.id, latest.id, {
      status: 'deprecated',
      reason: '仅用于批量警告',
      actor: { id: account.id },
    })
    const warned = await api.batchUpgradeModuleDrafts(db, module.id, {
      toVersionId: latest.id,
      scenarioIds: [warnScenario.id],
      idempotencyKey: newId(),
      actor: { id: account.id },
    })
    expect(warned.results[0]).toMatchObject({
      scenarioId: warnScenario.id,
      status: 'skipped',
      code: 'MODULE_UPGRADE_CONFIRMATION_REQUIRED',
    })
    expect((await api.getScenario(db, warnScenario.id)).draft?.revision).toBe(warnScenario.draft?.revision)
  })

  it('AMC-08/09 弃用与撤回，并停用受影响场景', async () => {
    const { db, account, target } = await setup()
    const { module, versions } = await publishModule(db, account.id, target.id, 'order.status', echoContent())
    const v1 = versions[0]!
    const scenario = await userScenario(db, account.id, target.id, '引用中', invocationDoc(module.id, v1.id))
    await api.publishScenarioDraft(db, scenario.id, { revision: scenario.draft!.revision, actor: { id: account.id } })

    const deprecated = await api.updateModulePublication(db, module.id, v1.id, {
      status: 'deprecated',
      reason: '准备升级',
      actor: { id: account.id },
    })
    expect(deprecated.publicationStatus).toBe('deprecated')
    const withdrawn = await api.updateModulePublication(db, module.id, v1.id, {
      status: 'withdrawn',
      reason: '发现错误',
      actor: { id: account.id },
    })
    expect(withdrawn.publicationStatus).toBe('withdrawn')
    await expect(api.publishScenarioDraft(db, scenario.id, {
      revision: (await api.getScenario(db, scenario.id)).draft!.revision,
      actor: { id: account.id },
    })).rejects.toThrow()

    const disabled = await api.disableAffectedScenarios(db, module.id, {
      versionId: v1.id,
      scenarioIds: [scenario.id],
      confirm: true,
      reason: '紧急停用',
      idempotencyKey: newId(),
      actor: { id: account.id },
    })
    expect(disabled.results[0]).toMatchObject({ scenarioId: scenario.id, status: 'disabled' })
    expect((await api.getScenario(db, scenario.id)).status).toBe('disabled')
  })

  it('AMC-10 被用户引用时不能删除', async () => {
    const { db, account, target } = await setup()
    const { module, versions } = await publishModule(db, account.id, target.id, 'order.keep', echoContent())
    await userScenario(db, account.id, target.id, '占用', invocationDoc(module.id, versions[0]!.id))
    const preview = await api.previewDeleteActionModule(db, module.id)
    expect(preview.draftReferences.length).toBe(1)
    await expect(api.deleteActionModule(db, module.id, { id: account.id })).rejects.toMatchObject({ code: 'MODULE_REFERENCED' })

    const isolated = await publishModule(db, account.id, target.id, 'order.free', echoContent())
    await api.getOrCreateModuleVerificationScenario(db, {
      moduleId: isolated.module.id,
      actor: { id: account.id },
    })
    const deleted = await api.deleteActionModule(db, isolated.module.id, { id: account.id })
    expect(deleted.id).toBe(isolated.module.id)
    await expect(api.getActionModule(db, isolated.module.id)).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' })
  })

  it('AMC-11 提炼不改原场景，替换后草稿变为调用', async () => {
    const { db, account, target } = await setup()
    const fill: Step = {
      id: newId(),
      name: '回显输入',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { from: 'keyword' },
    }
    const extract: Step = {
      id: newId(),
      name: '提取',
      type: 'extract',
      effectType: 'READ_ONLY',
      outputKey: 'extracted',
      input: { target: { framePath: [], candidates: [{ by: 'text', value: '结果' }] }, as: 'text' },
    }
    const assert: Step = {
      id: newId(),
      name: '断言',
      type: 'assert',
      effectType: 'READ_ONLY',
      input: { expect: { kind: 'text_contains', value: '完成' } },
    }
    const later: Step = {
      id: newId(),
      name: '后续',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { from: 'extracted' },
    }
    const document: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [{ key: 'keyword', label: '关键词' }],
      nodes: [
        { kind: 'step', step: fill },
        { kind: 'step', step: extract },
        { kind: 'step', step: assert },
        { kind: 'step', step: later },
      ],
    }
    const scenario = await userScenario(db, account.id, target.id, '待提炼', document)
    const proposal = await api.proposeExtractFromScenario(db, scenario.id, [fill.id, extract.id, assert.id])
    expect(proposal.inputs).toHaveLength(1)
    expect(proposal.outputs).toHaveLength(1)
    expect(proposal.postconditionCandidates).toHaveLength(1)
    expect(proposal.effectCeiling).toBe('READ_ONLY')

    const extracted = await api.extractModuleFromScenario(db, scenario.id, {
      stepIds: [fill.id, extract.id, assert.id],
      name: '查询结果',
      key: 'order.extract',
      confirmedPostconditionStepIds: [assert.id],
      idempotencyKey: newId(),
      actor: { id: account.id },
    })
    expect(extracted.capabilityKey).toBe('order.extract')
    expect((await api.getScenario(db, scenario.id)).draft?.revision).toBe(scenario.draft?.revision)
    const published = await publishCurrentDraft(db, extracted.id, account.id, extracted.draftRevision ?? 0)
    const version = (await api.listActionModuleVersions(db, published.id)).items[0]!
    const compare = await api.previewReplaceStepsWithModule(db, scenario.id, {
      stepIds: [fill.id, extract.id, assert.id],
      moduleVersionId: version.id,
    })
    expect(compare.equal).toBe(true)
    const replaced = await api.replaceStepsWithModule(db, scenario.id, {
      stepIds: [fill.id, extract.id, assert.id],
      moduleVersionId: version.id,
      baseRevision: scenario.draft!.revision,
      idempotencyKey: newId(),
      actor: { id: account.id },
    })
    const nodes = (replaced.draft!.document as ScenarioAuthoringDocumentV2).nodes
    expect(nodes[0]).toMatchObject({ kind: 'module' })
    expect(nodes[1]).toMatchObject({ kind: 'step' })
    const expansion = await api.previewScenarioExpansion(db, replaced.id, {})
    const expanded = expansion.definition?.steps ?? []
    expect(expanded.map((step) => step.type)).toEqual(expect.arrayContaining(['echo', 'extract', 'assert', 'echo']))
    expect(expanded.some((step) => step.outputKey === 'extracted')).toBe(true)
  })
})
