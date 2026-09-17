import { describe, expect, it } from 'vitest'
import {
  latestSelectableVersion,
  upgradeWarningKey,
  type AuthoringModuleInvocation,
  type ModuleContent,
  type ScenarioAuthoringDocumentV2,
  type Step,
  type UpgradeModuleVersion,
} from '@cairn/shared'
import {
  applyModuleReplace,
  applyModuleUpgrade,
  buildExtractedModuleContent,
  buildReplaceInvocation,
  compareReplaceSteps,
  diffModuleVersions,
  proposeModuleFromSteps,
  unconfirmedUpgradeWarnings,
  unresolvedUpgradeBlockers,
} from '../index.js'

const moduleId = '22222222-2222-4222-8222-222222222222'
const version1 = '33333333-3333-4333-8333-333333333333'
const version2 = '44444444-4444-4444-8444-444444444444'
const invocationId = '55555555-5555-4555-8555-555555555555'
const laterStepId = '66666666-6666-4666-8666-666666666666'
const echoId = '77777777-7777-4777-8777-777777777777'
const extractId = '88888888-8888-4888-8888-888888888888'
const assertId = '99999999-9999-4999-8999-999999999999'
const fillId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function echo(id: string, name: string, from: string, outputKey?: string): Step {
  return {
    id,
    name,
    type: 'echo',
    effectType: 'READ_ONLY',
    outputKey,
    input: { from },
  }
}

function content(overrides: Partial<ModuleContent['contract']> & { steps?: Step[]; mapping?: Record<string, string> }): ModuleContent {
  const steps = overrides.steps ?? [
    echo(echoId, '回显', 'keyword', 'internal'),
  ]
  return {
    contract: {
      inputs: overrides.inputs ?? [{ key: 'keyword', label: '关键词', valueType: 'string', required: true }],
      outputs: overrides.outputs ?? [{ key: 'result', label: '结果', shape: { kind: 'scalar', type: 'string' } }],
      effectCeiling: overrides.effectCeiling ?? 'READ_ONLY',
      preconditions: overrides.preconditions ?? [],
      postconditions: overrides.postconditions ?? [
        { meaning: '有结果', verification: { kind: 'output_required', outputKey: 'result' } },
      ],
    },
    implementations: [
      {
        implementationKey: 'default',
        kind: 'structured_steps',
        steps,
        outputMapping: overrides.mapping ?? { result: 'internal' },
      },
    ],
  }
}

function version(partial: Partial<UpgradeModuleVersion> & { versionId: string; versionNo: number }): UpgradeModuleVersion {
  const body = content({})
  return {
    moduleId,
    publicationStatus: 'published',
    contractDigest: 'c1',
    implementationDigest: 'i1',
    contentDigest: 'd1',
    executionMode: 'DETERMINISTIC',
    effectCeiling: 'READ_ONLY',
    content: body,
    ...partial,
  }
}

function invocation(overrides: Partial<AuthoringModuleInvocation> = {}): AuthoringModuleInvocation {
  return {
    kind: 'module',
    invocationId,
    name: '查询',
    moduleId,
    moduleVersionId: version1,
    implementationKey: 'default',
    inputBindings: { keyword: { kind: 'from', key: 'keyword' } },
    outputBindings: { result: 'result' },
    ...overrides,
  }
}

function document(nodes: ScenarioAuthoringDocumentV2['nodes']): ScenarioAuthoringDocumentV2 {
  return {
    authoringSchemaVersion: 2,
    schemaVersion: 1,
    inputs: [{ key: 'keyword', label: '关键词' }],
    nodes,
  }
}

describe('AM-C 升级差异与提炼纯函数', () => {
  it('AMC-02 契约未变时只标实现变化', () => {
    const from = version({ versionId: version1, versionNo: 1, contractDigest: 'same', implementationDigest: 'old' })
    const to = version({
      versionId: version2,
      versionNo: 2,
      contractDigest: 'same',
      implementationDigest: 'new',
      content: content({
        steps: [echo(echoId, '回显改名', 'keyword', 'internal')],
      }),
    })
    const diffs = diffModuleVersions({
      from,
      to,
      document: document([invocation()]),
      invocation: invocation(),
    })
    expect(diffs.map((item) => item.code)).toContain('MODULE_UPGRADE_IMPLEMENTATION_ONLY')
    expect(diffs.every((item) => item.severity !== 'blocking')).toBe(true)
    expect(diffs.find((item) => item.code === 'MODULE_UPGRADE_IMPLEMENTATION_ONLY')?.implementationSummary?.changed).toContain('回显改名')
  })

  it('AMC-04 被后续步骤引用的输出删除时阻断并列出节点', () => {
    const from = version({ versionId: version1, versionNo: 1 })
    const to = version({
      versionId: version2,
      versionNo: 2,
      contractDigest: 'changed',
      content: content({
        outputs: [],
        mapping: {},
        postconditions: [],
      }),
    })
    const diffs = diffModuleVersions({
      from,
      to,
      document: document([
        invocation(),
        { kind: 'step', step: echo(laterStepId, '后续回显', 'result') },
      ]),
      invocation: invocation(),
    })
    const removed = diffs.find((item) => item.code === 'MODULE_UPGRADE_OUTPUT_REMOVED')
    expect(removed?.severity).toBe('blocking')
    expect(removed?.affectedNodeIds).toContain(laterStepId)
  })

  it('新增必填输入在未补绑定时保持阻断，补绑定后解除', () => {
    const from = version({ versionId: version1, versionNo: 1 })
    const to = version({
      versionId: version2,
      versionNo: 2,
      contractDigest: 'changed',
      content: content({
        inputs: [
          { key: 'keyword', label: '关键词', valueType: 'string', required: true },
          { key: 'limit', label: '条数', valueType: 'number', required: true },
        ],
      }),
    })
    const current = invocation()
    const diffs = diffModuleVersions({ from, to, document: document([current]), invocation: current })
    expect(unresolvedUpgradeBlockers(diffs, current, to.content.contract).some((item) => item.code === 'MODULE_UPGRADE_INPUT_REQUIRED')).toBe(true)
    expect(
      unresolvedUpgradeBlockers(diffs, current, to.content.contract, { limit: { kind: 'literal', value: 10 } }),
    ).toHaveLength(0)
  })

  it('AMC-05 执行方式变为 AI 时标警告，不自动确认', () => {
    const from = version({ versionId: version1, versionNo: 1, executionMode: 'DETERMINISTIC' })
    const to = version({
      versionId: version2,
      versionNo: 2,
      executionMode: 'AI',
      contractDigest: 'same',
      implementationDigest: 'ai',
    })
    const diffs = diffModuleVersions({
      from,
      to,
      document: document([invocation()]),
      invocation: invocation(),
    })
    const mode = diffs.find((item) => item.code === 'MODULE_UPGRADE_EXECUTION_MODE')
    expect(mode?.severity).toBe('warning')
    expect(unconfirmedUpgradeWarnings(diffs.filter((item) => item.severity === 'warning'), [])).toContainEqual(
      expect.objectContaining({ code: 'MODULE_UPGRADE_EXECUTION_MODE' }),
    )
  })

  it('未确认的警告不会被同码一次带过', () => {
    const from = version({ versionId: version1, versionNo: 1, effectCeiling: 'READ_ONLY' })
    const to = version({
      versionId: version2,
      versionNo: 2,
      publicationStatus: 'deprecated',
      effectCeiling: 'SIDE_EFFECT',
      content: content({ effectCeiling: 'SIDE_EFFECT' }),
    })
    const diffs = diffModuleVersions({
      from,
      to,
      document: document([invocation()]),
      invocation: invocation(),
    })
    const warnings = diffs.filter((item) => item.severity === 'warning')
    expect(warnings.length).toBeGreaterThan(1)
    expect(unconfirmedUpgradeWarnings(warnings, [upgradeWarningKey(warnings[0]!)])).toHaveLength(warnings.length - 1)
  })

  it('applyModuleUpgrade 只改目标调用并丢掉已删除输入绑定', () => {
    const next = applyModuleUpgrade({
      document: document([
        invocation({ inputBindings: { keyword: { kind: 'literal', value: 'a' }, gone: { kind: 'literal', value: 'x' } } }),
      ]),
      invocationId,
      toVersionId: version2,
      toContract: content({
        inputs: [{ key: 'keyword', label: '关键词', valueType: 'string', required: true }],
      }).contract,
    })
    const node = next.nodes[0]
    expect(node?.kind).toBe('module')
    if (node?.kind !== 'module') return
    expect(node.moduleVersionId).toBe(version2)
    expect(node.inputBindings).toEqual({ keyword: { kind: 'literal', value: 'a' } })
    expect(node.moduleDraft).toBeUndefined()
  })

  it('AMC-11 提炼推断输入、输出、后置条件与副作用上限', () => {
    const fill: Step = {
      id: fillId,
      name: '填写',
      type: 'fill',
      effectType: 'IDEMPOTENT',
      input: {
        target: { framePath: [], candidates: [{ by: 'css', value: '#q' }] },
        from: 'keyword',
      },
    }
    const extract: Step = {
      id: extractId,
      name: '提取',
      type: 'extract',
      effectType: 'READ_ONLY',
      outputKey: 'extracted',
      input: {
        target: { framePath: [], candidates: [{ by: 'text', value: '结果' }] },
        as: 'text',
      },
    }
    const assert: Step = {
      id: assertId,
      name: '断言可见',
      type: 'assert',
      effectType: 'READ_ONLY',
      input: { expect: { kind: 'text_contains', value: '完成' } },
    }
    const later: Step = echo(laterStepId, '后续', 'extracted')
    const doc = document([
      { kind: 'step', step: fill },
      { kind: 'step', step: extract },
      { kind: 'step', step: assert },
      { kind: 'step', step: later },
    ])
    const proposal = proposeModuleFromSteps(doc, [fillId, extractId, assertId])
    expect(proposal.ok).toBe(true)
    expect(proposal.inputs).toEqual([
      expect.objectContaining({ key: 'keyword', source: 'scenario_input', required: true }),
    ])
    expect(proposal.outputs).toEqual([
      expect.objectContaining({ key: 'extracted', internalOutputKey: 'extracted' }),
    ])
    expect(proposal.postconditionCandidates).toEqual([
      expect.objectContaining({ stepId: assertId }),
    ])
    expect(proposal.effectCeiling).toBe('IDEMPOTENT')

    const built = buildExtractedModuleContent({
      document: doc,
      selectedStepIds: [fillId, extractId, assertId],
      confirmedPostconditionStepIds: [assertId],
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.content.contract.effectCeiling).toBe('IDEMPOTENT')
    expect(built.content.contract.outputs.map((item) => item.key)).toEqual(['extracted'])

    const replaced = applyModuleReplace({
      document: doc,
      selectedStepIds: [fillId, extractId, assertId],
      invocation: buildReplaceInvocation({
        document: doc,
        selectedStepIds: [fillId, extractId, assertId],
        moduleId,
        moduleVersionId: version1,
        invocationId,
        name: '查询模块',
      }),
    })
    expect(replaced.nodes).toHaveLength(2)
    expect(replaced.nodes[0]).toMatchObject({ kind: 'module', moduleVersionId: version1 })
    expect(replaced.nodes[1]).toMatchObject({ kind: 'step', step: { id: laterStepId } })
  })

  it('非连续选择被拒绝', () => {
    const first = echo(fillId, 'A', 'keyword', 'a')
    const mid = echo(extractId, 'B', 'a', 'b')
    const last = echo(assertId, 'C', 'b')
    const proposal = proposeModuleFromSteps(
      document([
        { kind: 'step', step: first },
        { kind: 'step', step: mid },
        { kind: 'step', step: last },
      ]),
      [fillId, assertId],
    )
    expect(proposal.ok).toBe(false)
    expect(proposal.error?.code).toBe('MODULE_EXTRACT_SELECTION_INVALID')
  })

  it('替换对比忽略内部步骤 id，核对类型与输入', () => {
    const original = [echo(echoId, '回显', 'keyword', 'extracted')]
    const expanded = [echo(laterStepId, '回显', 'keyword', 'extracted')]
    const rows = compareReplaceSteps(original, expanded, new Set(['extracted']))
    expect(rows[0]?.equal).toBe(true)
  })

  it('latestSelectableVersion 忽略 withdrawn', () => {
    const latest = latestSelectableVersion([
      { versionNo: 3, publicationStatus: 'withdrawn' as const },
      { versionNo: 2, publicationStatus: 'deprecated' as const },
      { versionNo: 1, publicationStatus: 'published' as const },
    ])
    expect(latest?.versionNo).toBe(2)
  })
})
